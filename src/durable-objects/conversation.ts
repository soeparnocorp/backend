import { Hono } from "hono";
import { cors } from "hono/cors";
import { DurableObject } from "cloudflare:workers";
import { Browsable } from "@outerbase/browsable-durable-object";
import { Env } from "../types/env";

@Browsable()
export class ConversationDurableObject extends DurableObject<Env> {
    private app: Hono = new Hono();
    public sql: SqlStorage;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.setup()
    }

    private async setup() {
        await this.executeQuery({
            sql: `
                CREATE TABLE IF NOT EXISTS message (
                    id TEXT PRIMARY KEY,
                    channel_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    content TEXT NOT NULL,
                    assets TEXT DEFAULT '[]',
                    created_at INTEGER DEFAULT (unixepoch())
                );
            `
        });

        this.setupRoutes();
    }

    private setupRoutes() {
        this.app.use('*', cors());

        this.app.get('/channel/messages', async (c) => {
            const channelId = c.req.header('X-Channel-Id');
            const limit = parseInt(c.req.query('limit') || '50');
            const before = c.req.query('before');

            const messages = await this.executeQuery({
                sql: `
                    SELECT m.*
                    FROM message m
                    WHERE m.channel_id = ?
                    ${before ? 'AND m.created_at < (SELECT created_at FROM message WHERE id = ?)' : ''}
                    ORDER BY m.created_at DESC
                    LIMIT ?
                `,
                params: before ? [channelId, before, limit] : [channelId, limit]
            });

            return c.json({ 
                success: true, 
                messages,
                hasMore: (messages as any[]).length === limit 
            });
        });

        this.app.post('/channel/messages', async (c) => {
            const channelId = c.req.header('X-Channel-Id');
            const sessionId = c.req.header('X-Session-Id');

            // Validate session and get userId from Authorization DO
            let id = this.env.AUTHORIZATION_DURABLE_OBJECT.idFromName('default');
            let authDO = this.env.AUTHORIZATION_DURABLE_OBJECT.get(id);
            const { valid, userId } = await (authDO as any).validateSession(sessionId);

            if (!valid || !userId) {
                return c.json({ success: false, error: 'Invalid session' }, 401);
            }

            const { content, assets } = await c.req.json();

            if (!content?.trim()) {
                return c.json({ success: false, error: 'Message content is required' }, 400);
            }

            const messageId = crypto.randomUUID()
            const assetsJson = JSON.stringify(assets);

            const result = await this.executeQuery({
                sql: `
                    INSERT INTO message (id, channel_id, user_id, content, assets)
                    VALUES (?, ?, ?, ?, ?)
                `,
                params: [messageId, channelId, userId, content, assetsJson]
            });

            const [message] = await this.executeQuery({
                sql: `
                    SELECT 
                        m.*
                    FROM message m
                    WHERE m.id = ?
                `,
                params: [messageId]
            }) as Record<string, SqlStorageValue>[];

            // Notify Authorization DO about the new message
            await (authDO as any).notify(channelId, message);

            return c.json({ 
                success: true, 
                message 
            });
        });

        this.app.post('/channel/upload', async (c) => {
            const channelId = c.req.header('X-Channel-Id');
            const sessionId = c.req.header('X-Session-Id');

            // Validate session and get userId from Authorization DO
            let id = this.env.AUTHORIZATION_DURABLE_OBJECT.idFromName('default');
            let authDO = this.env.AUTHORIZATION_DURABLE_OBJECT.get(id);
            const { valid, userId } = await (authDO as any).validateSession(sessionId);

            if (!valid || !userId) {
                return c.json({ success: false, error: 'Invalid session' }, 401);
            }

            // Get the file from the request
            const formData = await c.req.formData();
            const file = formData.get('file') as File;

            if (!file) {
                return c.json({ success: false, error: 'No file provided' }, 400);
            }

            // Generate a unique filename
            const fileExtension = file.name.split('.').pop();
            const uniqueFilename = `${channelId}/${crypto.randomUUID()}.${fileExtension}`;

            // Upload to R2
            try {
                await this.env.MESSAGE_ASSETS.put(uniqueFilename, file, {
                    httpMetadata: {
                        contentType: file.type,
                    }
                });

                // Generate presigned URL
                const accountId = "53d61c09062b1ca11788fa763f79313a";
                const accessKeyId = c.env.R2_ACCESS_KEY_ID;
                const secretAccessKey = c.env.R2_SECRET_ACCESS_KEY;
                const bucketName = "message-assets";

                // Create signature using HMAC-SHA1 for AWS S3 compatible presigned URL
                const presignedUrl = await generatePresignedUrl(
                    accountId,
                    accessKeyId,
                    secretAccessKey,
                    bucketName,
                    uniqueFilename,
                    3600 // 1 hour expiration
                );

                return c.json({ 
                    success: true, 
                    url: presignedUrl
                });
            } catch (error) {
                console.error('File upload error:', error);
                return c.json({ 
                    success: false, 
                    error: 'Failed to upload file' 
                }, 500);
            }
        });
    }

    async fetch(request: Request): Promise<Response> {
        return this.app.fetch(request);
    }

    private async executeRawQuery<
        T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>,
    >(opts: { sql: string; params?: unknown[] }) {
        const { sql, params } = opts

        try {
            let cursor

            if (params && params.length) {
                cursor = this.sql.exec<T>(sql, ...params)
            } else {
                cursor = this.sql.exec<T>(sql)
            }

            return cursor
        } catch (error) {
            console.error('SQL Execution Error:', error)
            throw error
        }
    }

    public async executeQuery<T extends Record<string, SqlStorageValue>>(opts: {
        sql: string
        params?: unknown[]
        isRaw?: boolean
    }): Promise<T[] | { columns: string[]; rows: SqlStorageValue[][]; meta: { rows_read: number; rows_written: number } }> {
        const cursor = await this.executeRawQuery<T>(opts)

        if (opts.isRaw) {
            return {
                columns: cursor.columnNames,
                rows: Array.from(cursor.raw()),
                meta: {
                    rows_read: cursor.rowsRead,
                    rows_written: cursor.rowsWritten,
                },
            }
        }

        return cursor.toArray()
    }
}

// Helper function to generate presigned URL
async function generatePresignedUrl(
    accountId: string,
    accessKeyId: string,
    secretAccessKey: string,
    bucketName: string,
    key: string,
    expiresIn: number
): Promise<string> {
    const host = `${accountId}.r2.cloudflarestorage.com`;
    const region = "auto";
    const service = "s3";
    const algorithm = "AWS4-HMAC-SHA1";
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);

    // Create signing key
    const kSecret = `AWS4${secretAccessKey}`;
    const kDate = await hmac(kSecret, dateStamp);
    const kRegion = await hmac(kDate, region);
    const kService = await hmac(kRegion, service);
    const kSigning = await hmac(kService, "aws4_request");

    // Create canonical request
    const method = "GET";
    const canonicalUri = `/${bucketName}/${key}`;
    const canonicalQuerystring = `X-Amz-Algorithm=${algorithm}&X-Amz-Credential=${encodeURIComponent(`${accessKeyId}/${dateStamp}/${region}/${service}/aws4_request`)}&X-Amz-Date=${amzDate}&X-Amz-Expires=${expiresIn}&X-Amz-SignedHeaders=host`;
    const canonicalHeaders = `host:${host}\n`;
    const signedHeaders = "host";
    const payloadHash = "UNSIGNED-PAYLOAD";
    const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuerystring}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

    // Create string to sign
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${await sha1(canonicalRequest)}`;

    // Create signature
    const signature = await hmac(kSigning, stringToSign);

    // Build final URL
    const signedUrl = `https://${host}${canonicalUri}?${canonicalQuerystring}&X-Amz-Signature=${signature}`;
    return signedUrl;
}

// HMAC-SHA1 implementation
async function hmac(key: string | ArrayBuffer, data: string): Promise<string> {
    const keyData = typeof key === "string" ? new TextEncoder().encode(key) : key;
    const dataData = new TextEncoder().encode(data);
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "HMAC", hash: "SHA-1" },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        dataData
    );
    return Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

// SHA-1 implementation
async function sha1(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest("SHA-1", encoder.encode(data));
    return Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}
