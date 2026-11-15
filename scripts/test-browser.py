"""Browser regression tests (Python Playwright + Chromium, no decoder downloads)."""
import functools
import http.server
import os
import pathlib
import shutil
import threading
import zipfile
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'assets'


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def run():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as p:
            executable = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium')
            browser = p.chromium.launch(executable_path=executable, headless=True, args=['--no-sandbox'])
            context = browser.new_context(viewport={'width': 1380, 'height': 950}, accept_downloads=True)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script("""window.jobs=[];window.delayWorker=0;
                const original=Worker.prototype.postMessage;
                Worker.prototype.postMessage=function(message,transfer){
                  if(message.jobId){jobs.push({jobId:message.jobId,settings:{...message.settings}});
                    if(delayWorker){setTimeout(()=>original.call(this,message,transfer),delayWorker);return;}}
                  return original.call(this,message,transfer);
                };""")
            page.goto(origin)
            expect(page.locator('#samples .card-status').filter(has_text='Ready')).to_have_count(4, timeout=30000)
            assert page.locator('#samples .adjust-panel:visible').count() == 4
            assert page.locator('[data-field="padding"], [data-field="hardEdges"]').count() == 0
            print('PASS: four reference sources, fixed padding and smooth edges')
            # Use real PNG data and mixed clipboard items, not image URLs or HTML.
            page.evaluate("""async()=>{window.clipBlob=await (await fetch('assets/administrator-transparent.png')).blob();
              window.paste=(count,text=true)=>{const d=new DataTransfer();
                if(text){d.setData('text/plain','ignored');d.setData('text/html','<img src=\"https://invalid.test/never-fetch.png\">');}
                for(let i=0;i<count;i++)d.items.add(new File([clipBlob],`paste-${i}.png`,{type:'image/png'}));
                document.body.dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}));};}""")
            page.evaluate('paste(2)')
            expect(page.locator('#toast')).to_contain_text('Multiple images found')
            expect(page.locator('#custom-items .signature-card')).to_have_count(0)
            page.evaluate('paste(0)')
            expect(page.locator('#toast')).to_contain_text('No image found')
            page.evaluate('paste(1)')
            custom = page.locator('#custom-items .signature-card').first
            expect(custom.locator('.card-status')).to_have_text('Ready', timeout=30000)
            expect(custom.locator('[data-field="sensitivity"]')).to_have_value('52')
            expect(custom.locator('[data-field="denoise"]')).to_have_value('45')
            expect(custom.locator('[data-field="rotation"]')).to_have_value('0')
            print('PASS: mixed text/image paste, multiple and text-only rejection')

            # Real clipboard API button on browsers supporting write/read PNG.
            context.grant_permissions(['clipboard-read', 'clipboard-write'], origin=origin)
            page.evaluate("""async()=>navigator.clipboard.write([new ClipboardItem({'image/png':clipBlob})])""")
            page.locator('#paste-image').click()
            expect(page.locator('#custom-items .signature-card')).to_have_count(2)
            expect(custom.locator('.card-status')).to_have_text('Ready', timeout=30000)
            # Stub a multi-item read since native Chromium may not expose >1 item.
            page.evaluate("""()=>{const read=navigator.clipboard.read.bind(navigator.clipboard);window.originalClipboardRead=read;
              navigator.clipboard.read=async()=>[new ClipboardItem({'image/png':clipBlob}),new ClipboardItem({'image/png':clipBlob})]}""")
            page.locator('#paste-image').click()
            expect(page.locator('#toast')).to_contain_text('Multiple images found')
            expect(page.locator('#custom-items .signature-card')).to_have_count(2)
            page.evaluate('navigator.clipboard.read=originalClipboardRead')
            # Native clipboard may re-encode PNGs. Keep the byte-identical event paste
            # as the source for the subsequent exact-content fingerprint tests.
            custom.locator('.remove').click()
            expect(page.locator('#custom-items .signature-card')).to_have_count(1)
            print('PASS: real clipboard button and multi-item rejection')

            # Slow the worker artificially, issue rapid values, then release.
            page.evaluate('jobs.length=0;delayWorker=350')
            sens = custom.locator('[data-field="sensitivity"]')
            custom.locator('button[aria-label="Increase ink sensitivity"]').click()
            expect(sens).to_have_value('53')
            expect(custom.locator('.card-status')).to_have_text('Processing')
            assert custom.locator('.compare-pane:last-child img').is_visible()
            assert custom.locator('.download').is_disabled()
            sens.evaluate("""async el=>{for(let value=54;value<=80;value++){el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,3));}el.dispatchEvent(new Event('change',{bubbles:true}));el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));}""")
            expect(sens).to_have_value('80')
            expect(custom.locator('.card-status')).to_have_text('Ready', timeout=30000)
            assert page.evaluate('jobs.map(j=>j.settings.sensitivity)') == [53,80], page.evaluate('jobs')
            assert page.evaluate('jobs.every(j=>j.settings.padding===2&&!j.settings.hardEdges)')
            assert page.evaluate("localStorage.getItem('e-sign:settings:v1')") is None
            page.evaluate('delayWorker=0')
            custom.locator('button[aria-label="Increase noise removal"]').click()
            expect(custom.locator('.card-status')).to_have_text('Ready', timeout=30000)
            custom.locator('button[aria-label="Increase rotation"]').click()
            expect(custom.locator('.card-status')).to_have_text('Ready', timeout=30000)
            custom.locator('.remember-card').click()
            saved = page.evaluate("JSON.parse(localStorage.getItem('e-sign:settings:v1'))")
            assert len(saved) == 1
            assert list(saved.values()) == [{'sensitivity':80,'denoise':46,'rotation':1}]
            key = next(iter(saved)); assert len(key.split(':')[0]) == 64 and key.endswith(':1')
            print('PASS: coalesced queue, immediate final request, only accepted config saved')

            # The exact clipboard bitmap is reloaded with a different name.
            raw = page.evaluate('async()=>Array.from(new Uint8Array(await clipBlob.arrayBuffer()))')
            page.set_input_files('#file-input', {'name':'renamed.png','mimeType':'image/png','buffer':bytes(raw)})
            expect(custom.locator('.card-status')).to_have_text('Ready', timeout=30000)
            expect(custom.locator('[data-field="sensitivity"]')).to_have_value('80')
            expect(custom.locator('[data-field="denoise"]')).to_have_value('46')
            expect(custom.locator('[data-field="rotation"]')).to_have_value('1')
            custom.locator('button[aria-label="Decrease ink sensitivity"]').click()
            expect(custom.locator('.card-status')).to_have_text('Ready', timeout=30000)
            with page.expect_download() as d:
                custom.locator('.download').click()
            assert d.value.suggested_filename.endswith('.png')
            saved = page.evaluate("JSON.parse(localStorage.getItem('e-sign:settings:v1'))")
            assert len(saved)==1 and saved[key]['sensitivity']==79
            # Same name, different content is not a match.
            page.set_input_files('#file-input', {'name':'renamed.png','mimeType':'image/jpeg','buffer':(ASSETS/'administrator-white.jpg').read_bytes()})
            expect(custom.locator('.card-status')).to_have_text('Ready', timeout=30000)
            expect(custom.locator('[data-field="sensitivity"]')).to_have_value('52')
            page.reload()
            expect(page.locator('#samples .card-status').filter(has_text='Ready')).to_have_count(4, timeout=30000)
            sample = page.locator('#samples .signature-card').first
            expect(sample.locator('[data-field="sensitivity"]')).to_have_value('79')
            sample.locator('.reset-card').click()
            expect(sample.locator('.card-status')).to_have_text('Ready', timeout=30000)
            sample.locator('.remember-card').click()
            assert page.evaluate("JSON.parse(localStorage.getItem('e-sign:settings:v1'))") == {}
            print('PASS: exact-file recall, latest acceptance, reload and reset')
            with page.expect_download() as d:
                page.locator('#download-all').click()
            with zipfile.ZipFile(d.value.path()) as z:
                assert len(z.namelist())==4 and all(z.read(n).startswith(b'\x89PNG\r\n\x1a\n') for n in z.namelist())
            for width in (320,393,768,1380):
                page.set_viewport_size({'width':width,'height':900})
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'), width
            assert not errors, errors
            print('PASS: ZIP output, responsive widths, no JS errors')
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    run()
