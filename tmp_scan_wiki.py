from pathlib import Path
root = Path(r'F:\mynote\Wiki\Wiki')
files = sorted(root.rglob('*.md'), key=lambda p: str(p))
needs = []
for f in files:
    text = f.read_text('utf-8')
    if text.startswith('---'):
        parts = text.split('---', 2)
        if len(parts) < 3 or 'id:' not in parts[1] or 'generated:' in parts[1]:
            needs.append(str(f))
    else:
        needs.append(str(f))
print(len(files), len(needs))
for n in needs:
    print(n)
