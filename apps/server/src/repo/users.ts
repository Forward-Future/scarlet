import { User } from "@scarlet/shared";
import { newId } from "@scarlet/timeline";
import { now, type Db } from "../db.js";

interface UserRow {
  id: string;
  name: string;
  created_at: string;
}

const toUser = (r: UserRow): User => User.parse({ id: r.id, name: r.name, createdAt: r.created_at });

/**
 * The users table holds the single local user. Its email/role/password_hash
 * columns date from the multi-user versions and are filled with placeholders.
 */
export class UsersRepo {
  constructor(private readonly db: Db) {}

  get(id: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  /** The local user: the first owner (older multi-user databases), else the oldest user. */
  primary(): User | null {
    const row = this.db.prepare("SELECT * FROM users ORDER BY role = 'owner' DESC, created_at ASC LIMIT 1").get() as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  create(input: { name: string }): User {
    const row: UserRow = { id: newId("usr"), name: input.name, created_at: now() };
    this.db
      .prepare("INSERT INTO users (id, email, name, role, password_hash, created_at) SELECT ?, ?, ?, 'owner', '', ? WHERE NOT EXISTS (SELECT 1 FROM users)")
      .run(row.id, `${row.id}@scarlet.local`, row.name, row.created_at);
    return this.primary()!;
  }
}
