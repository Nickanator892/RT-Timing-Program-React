import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import fs from "fs";
//import path from "path";
import dotenv from "dotenv";

dotenv.config();

export class SQLController {
    private dbPath: string;

    constructor() {
        this.dbPath = process.env.DB_PATH || "";
        if (!this.dbPath) {
            throw new Error("DB_PATH environment variable not set");
        }
    }

    // Connect to database
    private async connectToDatabase(): Promise<Database<sqlite3.Database, sqlite3.Statement>> {
        if (!fs.existsSync(this.dbPath)) {
            throw new Error(`Database not found at path: ${this.dbPath}`);
        }

        const db = await open({
            filename: this.dbPath,
            driver: sqlite3.Database,
            mode: sqlite3.OPEN_READWRITE, // Read/write mode
        });

        return db;
    }

    // Execute query
    public async exec(query: string, params: any[] = []): Promise<any> {
        const db = await this.connectToDatabase();

        try {
            if (query.trim().toUpperCase().startsWith("SELECT")) {
                const rows = await db.all(query, params);
                return rows;
            } else {
                const result = await db.run(query, params);
                return result.changes; // Number of rows affected
            }
        } finally {
            await db.close();
        }
    }
}
