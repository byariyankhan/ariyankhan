#!/usr/bin/env python3
"""Which boards are hard, from play.

Reads the level_difficulty view (migration 015) and prints the boards that beat the most people, what a clear
costs on each, and the ones that beat nobody -- with the countries' names when games/data/puzzle.json is at
hand. Nothing here is personal: the view holds counts and averages per board, never a person.

Three ways to the numbers, tried in this order:

  --api URL      the public endpoint, e.g. https://ariyankhan.com/api/puzzle/v1/boards/difficulty (default)
  --dsn DSN      PostgreSQL directly, with psycopg if it is installed, else through the psql command
  --tsv FILE     a tab-separated dump of the view (psql -AF $'\\t'), for a file mailed from somewhere

  python3 games/puzzle/tools/hardest.py                       # the live game
  python3 games/puzzle/tools/hardest.py --min-players 10 --top 40
  python3 games/puzzle/tools/hardest.py --dsn postgresql://puzzle:...@127.0.0.1:5433/puzzle
  python3 games/puzzle/tools/hardest.py --csv out.csv         # the whole table, for a spreadsheet

The score is explainable on purpose: fail rate (how often a start ends with the hearts gone), plus a tenth of
a point per hint and per heart an average clear costs. Time is shown but not scored -- a big board is slow
without being hard.
"""
import argparse, csv, json, os, subprocess, sys, urllib.request

COLS = ['level_id', 'players', 'plays', 'clears', 'fails', 'fail_rate', 'hints_per_clear', 'hearts_per_clear', 'seconds_per_clear']


def num(v):
    if v in (None, '', 'NULL'):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def rows_from_api(url, min_players):
    with urllib.request.urlopen(f'{url}?min={min_players}', timeout=30) as r:
        return json.load(r)['boards']


def rows_from_dsn(dsn, min_players):
    sql = f'SELECT {", ".join(COLS)} FROM level_difficulty WHERE players >= {int(min_players)}'
    try:
        import psycopg  # type: ignore
        with psycopg.connect(dsn) as conn, conn.cursor() as cur:
            cur.execute(sql)
            return [dict(zip(COLS, row)) for row in cur.fetchall()]
    except ImportError:
        pass
    out = subprocess.run(['psql', dsn, '-AtF', '\t', '-c', sql], capture_output=True, text=True, check=True).stdout
    return [dict(zip(COLS, line.split('\t'))) for line in out.splitlines() if line.strip()]


def rows_from_tsv(path):
    with open(path, newline='') as f:
        reader = csv.DictReader(f, delimiter='\t')
        return list(reader)


def names(levels_path):
    try:
        with open(levels_path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    out = {}
    for lv in data.get('levels', []):
        out[str(lv.get('id'))] = lv.get('name') or str(lv.get('id'))
    return out


def score(r):
    fr = num(r.get('fail_rate')) or 0.0
    h = num(r.get('hints_per_clear')) or 0.0
    l = num(r.get('hearts_per_clear')) or 0.0
    return fr + 0.1 * h + 0.1 * l


def fmt(v, digits=2):
    x = num(v)
    return '-' if x is None else f'{x:.{digits}f}'


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--api', default='https://ariyankhan.com/api/puzzle/v1/boards/difficulty')
    ap.add_argument('--dsn')
    ap.add_argument('--tsv')
    ap.add_argument('--levels', default=os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'puzzle.json'))
    ap.add_argument('--min-players', type=int, default=3)
    ap.add_argument('--top', type=int, default=25)
    ap.add_argument('--csv', help='write the whole scored table here')
    a = ap.parse_args()

    if a.tsv:
        rows = rows_from_tsv(a.tsv)
    elif a.dsn:
        rows = rows_from_dsn(a.dsn, a.min_players)
    else:
        rows = rows_from_api(a.api, a.min_players)
    rows = [r for r in rows if (num(r.get('players')) or 0) >= a.min_players]
    label = names(a.levels)
    for r in rows:
        r['score'] = score(r)
        r['name'] = label.get(str(r['level_id']), str(r['level_id']))
    rows.sort(key=lambda r: (-r['score'], -(num(r.get('seconds_per_clear')) or 0)))

    if not rows:
        print(f'nothing counted yet with {a.min_players} players or more (try --min-players 1)')
        return
    total_players = max(int(num(r['players']) or 0) for r in rows)
    print(f'{len(rows)} boards with {a.min_players}+ players · the most-played board has {total_players} players\n')

    def table(title, subset):
        print(title)
        print(f'  {"board":<24} {"players":>7} {"starts":>6} {"clears":>6} {"fails":>5} {"fail%":>6} {"hints":>5} {"hearts":>6} {"sec":>6} {"score":>6}')
        for r in subset:
            fr = num(r.get('fail_rate'))
            print(f'  {r["name"][:24]:<24} {int(num(r["players"]) or 0):>7} {int(num(r["plays"]) or 0):>6} {int(num(r["clears"]) or 0):>6} '
                  f'{int(num(r["fails"]) or 0):>5} {("-" if fr is None else f"{fr*100:.0f}"):>6} {fmt(r.get("hints_per_clear")):>5} '
                  f'{fmt(r.get("hearts_per_clear")):>6} {fmt(r.get("seconds_per_clear"), 0):>6} {r["score"]:>6.2f}')
        print()

    table(f'Hardest {min(a.top, len(rows))}', rows[:a.top])
    easy = [r for r in rows if (num(r.get('clears')) or 0) > 0]
    easy.sort(key=lambda r: (r['score'], num(r.get('seconds_per_clear')) or 0))
    table('Easiest 10', easy[:10])

    if a.csv:
        with open(a.csv, 'w', newline='') as f:
            w = csv.writer(f)
            w.writerow(['name'] + COLS + ['score'])
            for r in rows:
                w.writerow([r['name']] + [r.get(c) for c in COLS] + [f'{r["score"]:.3f}'])
        print(f'wrote {a.csv}')


if __name__ == '__main__':
    main()
