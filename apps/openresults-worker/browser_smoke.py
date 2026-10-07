"""Offline browser smoke: launches the real installed Chromium as the image user."""
import asyncio
from playwright.async_api import async_playwright
import psutil
from local_resources import assert_resources

async def main():
    assert_resources()
    async with async_playwright() as playwright:
        browser=await playwright.chromium.launch(headless=True)
        try:
            page=await browser.new_page()
            await page.set_content('<title>race-platform-browser-smoke</title>')
            assert await page.title()=='race-platform-browser-smoke'
            assert await page.evaluate('6 * 7')==42
            resources=assert_resources()
            assert resources['rssBytes']>psutil.Process().memory_info().rss
            print('local_resources_with_chromium_passed')
            print('chromium_launch_dom_javascript_passed')
        finally:
            await browser.close()

if __name__=='__main__':asyncio.run(main())
