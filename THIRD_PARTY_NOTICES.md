# Third-party notices

just.MD ships unmodified copies of these libraries in `vendor/`. Each keeps its own license;
the license header inside each file is preserved, and the full license texts, taken from each
project at the version shipped, are in `vendor/LICENSES/`.

| File | Library | License | Full text |
|---|---|---|---|
| `vendor/marked-18.1.3.umd.js` | marked 18.1.3, Copyright (c) 2018+ MarkedJS; Copyright (c) 2011-2018 Christopher Jeffrey. Includes terms for Markdown, Copyright (c) 2004 John Gruber | MIT (marked); BSD-style (Markdown) | `vendor/LICENSES/marked-LICENSE.txt` |
| `vendor/purify-3.4.17.min.js` | DOMPurify 3.4.17, (c) Cure53 and other contributors | dual Apache-2.0 / MPL-2.0; just.MD uses it under Apache-2.0 | `vendor/LICENSES/DOMPurify-LICENSE.txt` |
| `vendor/highlight-11.12.0.min.js` | highlight.js 11.12.0, Copyright (c) 2006 Ivan Sagalaev; (c) 2006-2026 Josh Goebel and other contributors | BSD-3-Clause | `vendor/LICENSES/highlightjs-LICENSE.txt` |

Sources: https://github.com/markedjs/marked, https://github.com/cure53/DOMPurify,
https://github.com/highlightjs/highlight.js

The hand-out package (`tools/make_dist.py`) carries this file, `LICENSE` and `vendor/LICENSES/`.
