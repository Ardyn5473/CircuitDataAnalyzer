import csv, datetime as dt, os, shutil, sqlite3, sys, tempfile, time, zipfile
from pathlib import Path

CSV_FILES = [
    ("01_WayPoints.csv", "sess_0.db", "WayPoints"),
    ("02_Lap.csv", "sana_0.db", "lap"),
    ("03_Split.csv", "sana_0.db", "split"),
    ("04_POI.csv", "sess_0.db", "POI"),
    ("05_Session_Info.csv", "sess_0.db", "info"),
    ("06_Analysis_Info.csv", "sana_0.db", "info"),
    ("07_Beacon.csv", "sana_0.db", "beacon"),
]


def quote_safe_name(name):
    return name.replace('"', "'")


def export_table(db_path, table, out_csv, add_datetime=False):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        cur = con.execute(f'SELECT * FROM "{table}"')
        cols = [d[0] for d in cur.description]
        if add_datetime:
            cols.append("datetime_JST")
        with open(out_csv, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f, lineterminator="\r\n")
            w.writerow(cols)
            for row in cur:
                vals = [row[c] for c in [d[0] for d in cur.description]]
                if add_datetime:
                    try:
                        sec = int(row["time"])
                        ms = int(row["ms"])
                        jst = dt.datetime.fromtimestamp(sec, dt.timezone.utc) + dt.timedelta(hours=9, milliseconds=ms)
                        vals.append(jst.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3])
                    except Exception:
                        vals.append("")
                w.writerow(vals)
    finally:
        con.close()


def export_info(db_path, out_csv):
    export_table(db_path, "info", out_csv)


def convert(rcnx_path, output_root=None):
    rcnx_path = Path(rcnx_path).resolve()
    if output_root is None:
        output_root = rcnx_path.parent
    output_root = Path(output_root).resolve()
    base = rcnx_path.stem
    folder_name = f"{base}_CSV一式"
    work_dir = Path(tempfile.mkdtemp(prefix="rcnx_"))
    extract_dir = work_dir / "extract"
    csv_dir = work_dir / folder_name
    zip_path = output_root / f"{folder_name}.zip"
    try:
        extract_dir.mkdir(parents=True)
        csv_dir.mkdir(parents=True)
        with zipfile.ZipFile(rcnx_path, "r") as z:
            z.extractall(extract_dir)
        sess = extract_dir / "sess_0.db"
        sana = extract_dir / "sana_0.db"
        if not sess.exists() or not sana.exists():
            raise RuntimeError("RCNX内部のsess_0.db / sana_0.dbが見つかりません。対応形式ではない可能性があります。")
        export_table(sess, "WayPoints", csv_dir / "01_WayPoints.csv", add_datetime=True)
        export_table(sana, "lap", csv_dir / "02_Lap.csv")
        export_table(sana, "split", csv_dir / "03_Split.csv")
        export_table(sess, "POI", csv_dir / "04_POI.csv")
        export_info(sess, csv_dir / "05_Session_Info.csv")
        export_info(sana, csv_dir / "06_Analysis_Info.csv")
        export_table(sana, "beacon", csv_dir / "07_Beacon.csv")
        wp = count_rows(csv_dir / "01_WayPoints.csv")
        lap = count_rows(csv_dir / "02_Lap.csv")
        split = count_rows(csv_dir / "03_Split.csv")
        readme = csv_dir / "README.txt"
        readme.write_text(
            "RCNX CSV展開\n\n"
            "RCNX内部のSQLiteデータをCSV化したものです。\n\n"
            f"WayPoints: {wp:,}点\nLap: {lap:,}件\nSplit: {split:,}件\n\n"
            "datetime_JST は time + ms から作成した日本時間の表示用列です。\n",
            encoding="utf-8"
        )
        if zip_path.exists():
            stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
            zip_path = output_root / f"{folder_name}_{stamp}.zip"
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for p in sorted(csv_dir.iterdir()):
                z.write(p, arcname=f"{folder_name}/{p.name}")
        return zip_path
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def count_rows(path):
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        return max(0, sum(1 for _ in f) - 1)


def convert_folder(folder, output_root=None):
    folder = Path(folder)
    files = sorted(folder.glob("*.rcnx")) + sorted(folder.glob("*.RCNX"))
    results = []
    for p in files:
        try:
            print(f"[変換開始] {p.name}", flush=True)
            out = convert(p, output_root)
            print(f"[完了] {out}", flush=True)
            results.append((p, out, None))
        except Exception as e:
            print(f"[エラー] {p.name}: {e}", flush=True)
            results.append((p, None, e))
    return results


def watch(inbox, output_root):
    inbox = Path(inbox).resolve()
    output_root = Path(output_root).resolve()
    inbox.mkdir(parents=True, exist_ok=True)
    output_root.mkdir(parents=True, exist_ok=True)
    print("RCNX自動変換を開始しました。", flush=True)
    print(f"入力フォルダ: {inbox}", flush=True)
    print(f"出力フォルダ: {output_root}", flush=True)
    print("RCNXを入力フォルダへ入れると自動でZIP化します。終了: Ctrl+C", flush=True)
    seen = {}
    while True:
        for p in sorted(inbox.glob("*.rcnx")) + sorted(inbox.glob("*.RCNX")):
            try:
                stat = p.stat()
                sig = (stat.st_size, stat.st_mtime_ns)
            except FileNotFoundError:
                continue
            if seen.get(str(p)) == sig:
                continue
            # Copying may still be in progress. Require same size twice.
            time.sleep(1.0)
            try:
                stat2 = p.stat()
                if (stat2.st_size, stat2.st_mtime_ns) != sig:
                    continue
            except FileNotFoundError:
                continue
            seen[str(p)] = sig
            convert_folder(inbox, output_root)
        time.sleep(2)


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--watch":
        inbox = sys.argv[2] if len(sys.argv) >= 3 else "RCNX_INBOX"
        output = sys.argv[3] if len(sys.argv) >= 4 else "OUTPUT"
        watch(inbox, output)
    elif len(sys.argv) >= 2:
        convert_folder(Path(sys.argv[1]).parent, Path(sys.argv[2]) if len(sys.argv) >= 3 else Path(sys.argv[1]).parent)
    else:
        print("使い方: python rcnx_to_csv.py --watch RCNX_INBOX OUTPUT")
