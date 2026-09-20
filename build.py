"""Copy only public frontend assets for Netlify/Vercel static deployment."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parent
out = root / 'dist'
out.mkdir(exist_ok=True)
# Remove the obsolete generated bundle after switching to the compatible build.
(out / 'dexie.min.js').unlink(missing_ok=True)
for name in ('index.html', 'style.css', 'speech.js', 'edge-speech.js', 'app.js',
             'library.js', 'library-ui.js', 'learning.js', 'package-ui.js', 'dexie.js', 'dexie.LICENSE'):
    shutil.copyfile(root / name, out / name)
print('Static frontend ready in dist/')
