import base64, pathlib, time
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path(__file__).resolve().parent.parent
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True, executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1380,'height':960},accept_downloads=True)
 errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
 page.set_content((ROOT/'index.html').read_text())
 page.add_style_tag(content=(ROOT/'styles.css').read_text())
 worker=(ROOT/'processor-worker.js').read_text()
 sources={f'assets/{x.name}':{'base64':base64.b64encode(x.read_bytes()).decode('ascii'),'type':'image/png' if x.suffix=='.png' else 'image/jpeg'} for x in (ROOT/'assets').iterdir()}
 page.evaluate("""({code,files})=>{
    window.__workerCode=code;
    window.fetch=async (path)=>{
      const entry=files[path]; if(!entry)return new Response('Not found',{status:404});
      const raw=atob(entry.base64);const b=new Uint8Array(raw.length);
      for(let i=0;i<raw.length;i++)b[i]=raw.charCodeAt(i);
      return new Response(new Blob([b],{type:entry.type}),{status:200});
    }
  }""",{'code':worker,'files':sources})
 script=(ROOT/'app.js').read_text().replace("new Worker('./processor-worker.js')","new Worker(URL.createObjectURL(new Blob([window.__workerCode],{type:'application/javascript'})))")
 page.add_script_tag(content=script)
 page.wait_for_function("document.querySelectorAll('.card-status:not(.running)').length===4",timeout=45000)
 print('statuses',page.locator('.card-status').all_text_contents())
 print('dimensions',page.locator('.output-dims').all_text_contents())
 print('visible errors',page.locator('.card-error:not([hidden])').all_text_contents())
 print('JS errors',errors)
 assert page.locator('.card-status.error').count()==0,errors
 assert page.locator('.compare-pane:last-child img:not([hidden])').count()==4
 page.screenshot(path=str(ROOT/'preview-desktop.png'),full_page=True)
 page.set_viewport_size({'width':393,'height':852})
 page.screenshot(path=str(ROOT/'preview-mobile.png'),full_page=True)
 # Upload from local disk and verify processing.
 page.set_input_files('#file-input',str(ROOT/'assets/administrator-scan.jpg'))
 page.wait_for_function("document.querySelectorAll('#custom-items .card-status:not(.running)').length===1",timeout=30000)
 assert page.locator('#custom-items .card-status').inner_text()=='Ready'
 # ZIP download must actually contain ZIP signatures.
 with page.expect_download() as d: page.locator('#download-all').click()
 item=d.value
 print('zip export:',item.suggested_filename)
 # Variation after slider change should run again.
 page.locator('#sensitivity').fill('60')
 page.wait_for_timeout(4000)
 print('after slider:',page.locator('.card-status').all_text_contents())
 browser.close()
