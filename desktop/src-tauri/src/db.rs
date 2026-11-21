// db.rs —— SQLite 数据层（需求 Q20：本机 SQLite 数据库文件；图片另存本地目录）
use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Record {
    pub id: String,
    pub kind: String,      // expense | income  （用 kind 避免与 Rust 关键字 type 冲突）
    pub amount: i64,       // 金额（分，整数）—— 与 shared/core 口径一致
    pub cat: String,
    pub note: String,
    pub date: String,      // YYYY-MM-DD
    pub ts: i64,           // 毫秒时间戳
    pub image: String,     // 图片相对文件名，空表示无
    pub deleted: i32,      // 0/1 软删除 → 回收站（Q23）
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Category {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub icon: String,
    pub color: String,
    pub custom: i32,
}

pub fn db_path(appdata: &PathBuf) -> PathBuf {
    appdata.join("jianji.db")
}
pub fn images_dir(appdata: &PathBuf) -> PathBuf {
    appdata.join("images")
}

pub fn init(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS records (
           id TEXT PRIMARY KEY, kind TEXT NOT NULL, amount INTEGER NOT NULL,
           cat TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', date TEXT NOT NULL,
           ts INTEGER NOT NULL, image TEXT NOT NULL DEFAULT '', deleted INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_records_date ON records(date);
         CREATE INDEX IF NOT EXISTS idx_records_deleted ON records(deleted);
         CREATE TABLE IF NOT EXISTS categories (
           id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
           icon TEXT NOT NULL, color TEXT NOT NULL, custom INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS recurring (
           id TEXT PRIMARY KEY, kind TEXT NOT NULL, amount INTEGER NOT NULL, cat TEXT NOT NULL,
           note TEXT NOT NULL, day_of_month INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
           last_notified_month TEXT NOT NULL DEFAULT ''
         );",
    )?;
    // 预设分类（Q5：预设 + 自定义增删）
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM categories", [], |r| r.get(0))?;
    if count == 0 {
        let presets: Vec<(&str, &str, &str, &str, &str)> = vec![
            ("food", "餐饮", "expense", "🍜", "#4f5bd5"),
            ("grocery", "买菜", "expense", "🥬", "#6FAE5F"),
            ("daily", "日用", "expense", "🧴", "#4FB3A5"),
            ("clothing", "服饰", "expense", "👗", "#E5759B"),
            ("home", "居住", "expense", "🏠", "#7c86ff"),
            ("transport", "交通", "expense", "🚇", "#34c759"),
            ("medical", "医疗", "expense", "💊", "#ff2d55"),
            ("fun", "娱乐", "expense", "🎬", "#AF52DE"),
            ("study", "学习", "expense", "📚", "#32ADE6"),
            ("other", "其他", "expense", "📦", "#A79DA2"),
            ("salary", "工资", "income", "💰", "#34C759"),
            ("bonus", "奖金", "income", "🎁", "#FFCC00"),
            ("redpack", "红包", "income", "🧧", "#D9736E"),
            ("other_in", "其他", "income", "📥", "#A79DA2"),
        ];
        for (id, name, kind, icon, color) in presets {
            conn.execute(
                "INSERT INTO categories(id,name,kind,icon,color,custom) VALUES(?1,?2,?3,?4,?5,0)",
                params![id, name, kind, icon, color],
            )?;
        }
    }
    Ok(())
}

pub fn list_records(conn: &Connection, include_deleted: i32) -> SqlResult<Vec<Record>> {
    let sql = if include_deleted != 0 {
        "SELECT id,kind,amount,cat,note,date,ts,image,deleted FROM records ORDER BY ts DESC"
    } else {
        "SELECT id,kind,amount,cat,note,date,ts,image,deleted FROM records WHERE deleted=0 ORDER BY ts DESC"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |r| Ok(Record {
        id: r.get(0)?, kind: r.get(1)?, amount: r.get(2)?, cat: r.get(3)?,
        note: r.get(4)?, date: r.get(5)?, ts: r.get(6)?, image: r.get(7)?, deleted: r.get(8)?,
    }))?;
    let mut out = Vec::new();
    for row in rows { out.push(row?); }
    Ok(out)
}

pub fn upsert_record(conn: &Connection, r: &Record) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO records(id,kind,amount,cat,note,date,ts,image,deleted)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,amount=excluded.amount,cat=excluded.cat,
           note=excluded.note,date=excluded.date,ts=excluded.ts,image=excluded.image,deleted=excluded.deleted",
        params![r.id, r.kind, r.amount, r.cat, r.note, r.date, r.ts, r.image, r.deleted],
    )?;
    Ok(())
}

pub fn set_deleted(conn: &Connection, id: &str, deleted: i32) -> SqlResult<()> {
    conn.execute("UPDATE records SET deleted=?1 WHERE id=?2", params![deleted, id])?;
    Ok(())
}

pub fn list_categories(conn: &Connection) -> SqlResult<Vec<Category>> {
    let mut stmt = conn.prepare("SELECT id,name,kind,icon,color,custom FROM categories ORDER BY kind,custom,id")?;
    let rows = stmt.query_map([], |r| Ok(Category {
        id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, icon: r.get(3)?, color: r.get(4)?, custom: r.get(5)?,
    }))?;
    let mut out = Vec::new();
    for row in rows { out.push(row?); }
    Ok(out)
}

pub fn upsert_category(conn: &Connection, c: &Category) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO categories(id,name,kind,icon,color,custom) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,icon=excluded.icon,color=excluded.color",
        params![c.id, c.name, c.kind, c.icon, c.color, c.custom],
    )?;
    Ok(())
}

pub fn delete_category(conn: &Connection, id: &str) -> SqlResult<()> {
    conn.execute("DELETE FROM categories WHERE id=?1 AND custom=1", params![id])?;
    Ok(())
}

pub fn get_setting(conn: &Connection, key: &str) -> SqlResult<Option<String>> {
    let r = conn.query_row("SELECT value FROM settings WHERE key=?1", params![key], |r| r.get(0));
    match r { Ok(v) => Ok(Some(v)), Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None), Err(e) => Err(e) }
}
pub fn set_setting(conn: &Connection, key: &str, value: &str) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// 全量替换（导入 JSON 备份 / 云同步落地）
pub fn replace_all(conn: &mut Connection, records: &[Record], categories: &[Category]) -> SqlResult<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM records", [])?;
    for r in records { upsert_record(&tx, r)?; }
    if !categories.is_empty() {
        tx.execute("DELETE FROM categories WHERE custom=1", [])?;
        for c in categories.iter().filter(|c| c.custom == 1) { upsert_category(&tx, c)?; }
    }
    tx.commit()
}
