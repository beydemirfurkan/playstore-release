# Store graphics

Play validates every image on upload and again at commit. These are the rules
`check` and `images` enforce locally, so a wrong file never costs a round trip.

| type              | config key / default path                       | size                                                 | format             | alpha           | count           |
| ----------------- | ----------------------------------------------- | ---------------------------------------------------- | ------------------ | --------------- | --------------- |
| App icon          | `images.icon` · `icon.png`                      | exactly **512×512**                                  | PNG (32-bit)       | allowed         | 1               |
| Feature graphic   | `images.featureGraphic` · `feature-graphic.png` | exactly **1024×500**                                 | JPEG or 24-bit PNG | **not allowed** | 1, **required** |
| Phone screenshots | `images.phoneScreenshots` · `phone/`            | each side 320–3840 px; **long side ≤ 2× short side** | JPEG or 24-bit PNG | not allowed     | **2–8**         |
| 7-inch tablet     | `images.sevenInchScreenshots` · `tablet-7/`     | same                                                 | same               | not allowed     | 0–8             |
| 10-inch tablet    | `images.tenInchScreenshots` · `tablet-10/`      | same                                                 | same               | not allowed     | 0–8             |

Filename order is display order. A language subdirectory (`phone/tr-TR/`) overrides the base directory for that language; otherwise every language shares the base files.

## The aspect rule, and why iPhone screenshots fail {#phonescreenshots}

Play's words: _"The maximum dimension of your screenshot can't be more than twice as long as the minimum dimension."_ An App Store 6.7"/6.9" screenshot is 1290×2796 — ratio 2.17 — and is rejected. Safe targets:

- **1080×1920** (9:16) — the size Google recommends and the minimum for being featured.
- 1080×2160 (exactly 2:1) — the tallest allowed.

To reuse App Store artwork: re-render the same HTML mockup at 1080×1920, or letterbox 1290×2796 onto a 1290×2580 canvas (crop) — do not squash it.

## Feature graphic {#featuregraphic}

Required for every listing; Play refuses to commit without it (`400 … feature graphic`). 1024×500, no transparency, no text in the outer 10% (Play crops it on some surfaces). It is shown above the listing and behind the promo video.

## Icon {#icon}

512×512 32-bit PNG. Unlike the App Store, alpha is fine — Play applies its own mask. It is the _store_ icon; the launcher icon inside the bundle is separate (adaptive icon resources in `android/app/src/main/res`).

## Rendering exact sizes without design tools

The App Store screenshots in a project are usually HTML mockups rendered with headless Chrome; the same source works here at a different size:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
  --window-size=1080,1920 --screenshot=phone/01.png "http://localhost:8799/sales.html"
```

Or with a Playwright MCP: `browser_take_screenshot` with `scale: "css"` on an element sized 1080×1920 CSS pixels. Serve the HTML over `http://` (`python3 -m http.server 8799`) — `file:` is blocked by most MCP browsers.

Feature graphic: an HTML page with a 1024×500 body, screenshot it the same way.

Verify before uploading — `check` does this too:

```bash
sips -g pixelWidth -g pixelHeight -g hasAlpha phone/*.png feature-graphic.png
```

To strip alpha from a PNG (feature graphic, screenshots):

```bash
python3 -c "from PIL import Image; p='feature-graphic.png'; Image.open(p).convert('RGB').save(p)"
```

## What `images` does with them

- Compares the sha1 of every local file with what Play reports; uploads only what is missing, deletes (with `--prune`, the CLI default) what has no local counterpart.
- Single-file types are replaced when the hash differs.
- Play has **no reorder call**. If the set is identical but in a different order, `images` reports `images.order.differs`; `--reorder` deletes the set and re-uploads it in filename order.
- Images cannot be attached to a language that has no listing yet — `publish` writes the listing first; standalone `images` reports `images.listing.missing`.
