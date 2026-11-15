# E-Sign — Client-side signature extraction test bench

Static web application for evaluating handwritten signature image cleanup before integration into Sweet Times ERP. **This is an algorithm prototype, not a signature authentication system or signing platform.**

## Features

- Four included "Administrator" signature source images: transparent PNG, black-on-white JPG, scanned paper JPG, and angled paper photograph JPG.
- Show original and processed signature side by side for all four sources.
- Upload several additional files and process them identically.
- Automatic black-on-transparent PNG extraction using local contrast normalization, shadow/background suppression, connected-component noise filtering, crop-to-ink, and optional rotation.
- Preserve existing transparency for transparent source artwork.
- Four controls: ink sensitivity, noise removal, proportional crop padding, rotation correction; optional hard-edged black/transparent output.
- Individual transparent PNG downloads, plus bulk ZIP download.
- Input support: PNG, JPEG, SVG, PDF, HEIC/HEIF, GIF, BMP, TIFF, WebP, AVIF. Native decoder support may vary by browser; PDF, HEIC and TIFF use browser-side format libraries.
- PDF page selection and TIFF frame selection.
- No image-upload endpoint, no backend, no telemetry, no accounts.

## Online deployment

Repository: `budhi-halim/e-sign`

Expected Pages URL after publishing is enabled:

https://budhi-halim.github.io/e-sign/

The repository includes `.github/workflows/deploy.yml` to deploy static files after each push to `master`. A brand-new repository may require a one-time manual setting:

**Settings → Pages → Build and deployment → Source → GitHub Actions**.

If the deployment fails on `Configure Pages` with `404`, configure Pages as above, then rerun the workflow.

## Local use

The project must be served over HTTP(S) for the Web Worker and document decoders; opening `index.html` directly with `file://` is not supported.

On Windows, open **PowerShell** with working directory set to the extracted project folder, then run:

```powershell
py -m http.server 8769
```

Open `http://127.0.0.1:8769/`. Python is needed only for this optional local static server, not in the browser app or GitHub Pages.

## Algorithms and processing contracts

`processor-worker.js` is the independently reusable image extraction engine. It accepts RGBA pixels and settings and returns cropped RGBA pixels, where RGB is always black and alpha represents ink strength.

1. For genuinely transparent sources, derive ink from the source alpha channel rather than luminosity.
2. For opaque sources, calculate grayscale luminance and a local mean from a summed-area table. Local contrast removes paper shadows better than global thresholding.
3. Find dark-ink connected components, discard isolated dust and edge-touching regions, and retain important strokes and detached dots.
4. Expand each retained region by one pixel to preserve anti-aliasing, then crop tightly with equal padding on all four sides (default **2% of the shorter detected ink dimension**, vmin-style). There is no arbitrary minimum pixel padding; if strokes reach the source edge, transparent padding is generated outside the source rather than clamped. After optional rotation, crop again to avoid large transparent corners.
5. Optionally rotate the resulting transparent bitmap.

**Known limitations:** Complex images with other dark objects or multiple handwritten samples may need manual cropping; automatically correcting *perspective* is not yet implemented (manual rotation is not a replacement for homography). Fine, faint strokes and highly textured backgrounds may need sensitivity/noise adjustments. Browser-native AVIF/BMP/GIF/WebP support varies. HEIC, PDF and TIFF libraries require internet access the first time used.

## Third-party format decoders

Loaded only when needed, self-hosted on GitHub Pages:

- PDF: Mozilla PDF.js `3.11.174` from cdnjs
- HEIC/HEIF: `heic-to` `1.6.7` from jsDelivr
- TIFF: `UTIF.js` `3.1.0` and `pako` `1.0.11`

The GitHub Pages deployment workflow installs these exact versions and copies the decoders into `vendor/` under the same Pages origin. **UTIF 3.1.0 ships `UTIF.js` in npm, not `UTIF.min.js`; the build copies the real file and includes `pako` for compressed TIFFs.** For source-only local testing, the app falls back to pinned CDN URLs if `vendor/` is absent. The application never intentionally uploads signature content. Before production integration, eliminate the CDN fallback and enforce a strict Content Security Policy; third-party JavaScript loaded at runtime can technically access document pixels.

## Tests

In the source folder, the Node test `scripts/test-worker.cjs` runs the worker algorithm on the four reference samples. The no-dependency `scripts/test-padding.cjs` verifies resolution-independent margin percentages, including when the detected ink reaches close to the source border. The browser test `scripts/test-browser.py` verifies the interface, before/after images, custom upload, sliders and downloadable ZIP. These were executed during initial development; PDF/HEIC/TIFF library loading was not tested in the headless offline environment.

## ERP integration

The preprocessing algorithm is independent of ERP user roles, approvals and signature placement. Codex can reuse `processor-worker.js` and the decoding functions of `app.js`. The app intentionally does not save reusable signatures, sign documents, or write to the ERP server. Such behavior must be implemented separately with explicit authorized signing actions.

## Privacy and build processing

All four built-in reference images are downloaded as ordinary static files, then processed in the same browser Web Worker as uploaded images. User-selected files are decoded and processed inside the browser; GitHub Actions performs only code validation and bundles decoder scripts for static hosting. No GitHub Actions preprocessing and no image upload API are involved. For PDF/HEIC/TIFF, scripts are served from the GitHub Pages origin; a pinned CDN fallback exists only for incomplete local installations.
