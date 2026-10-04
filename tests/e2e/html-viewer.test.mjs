import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { launchApp } from "./helpers/app.mjs";

// An untrusted HTML file must not reach the network just by being opened:
// sandbox="" alone still loads images, stylesheets, fonts and frames.

async function remoteServer() {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    hits,
    origin,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function untrustedPage(origin) {
  return `<!doctype html>
<html><head>
<link rel="stylesheet" href="${origin}/style.css">
<style>
  @font-face { font-family: remote; src: url(${origin}/font.woff); }
  h1 { color: rgb(0, 128, 0); font-family: remote, serif; }
</style>
</head><body>
<h1>Doc</h1>
<p id="styled" style="color: rgb(255, 0, 0); background: url(${origin}/bg.png)">styled</p>
<img src="${origin}/pixel.gif">
<iframe src="${origin}/nested.html"></iframe>
<p id="out">idle</p>
<script src="${origin}/remote.js"></script>
<script>
  document.getElementById("out").textContent = "ran";
  fetch("${origin}/script-ran").catch(() => {});
</script>
</body></html>
`;
}

async function viewerText(app, selector) {
  return app.page.frameLocator("#html-viewer").locator(selector).textContent();
}

async function viewerColor(app, selector) {
  return app.page
    .frameLocator("#html-viewer")
    .locator(selector)
    .evaluate((el) => getComputedStyle(el).color);
}

// Give the frame time to request anything it was going to.
async function idle(app) {
  await app.settle();
  await app.page.waitForTimeout(400);
}

test("opening an HTML file renders it styled and makes no network request", async () => {
  const remote = await remoteServer();
  const app = await launchApp({ files: { "page.html": untrustedPage(remote.origin) } });
  try {
    await app.openFolder();
    await app.openFile("page.html");
    assert.equal(await viewerText(app, "h1"), "Doc");
    await idle(app);
    assert.equal(await viewerColor(app, "h1"), "rgb(0, 128, 0)", "inline <style> must apply");
    assert.equal(await viewerColor(app, "#styled"), "rgb(255, 0, 0)", "style attributes must apply");
    assert.equal(await viewerText(app, "#out"), "idle", "JavaScript is off by default");
    assert.deepEqual(remote.hits, [], "the HTML file must not load anything remote");
  } finally {
    await app.close();
    await remote.close();
  }
});

test("with JavaScript on, inline scripts run but still reach nothing remote", async () => {
  const remote = await remoteServer();
  const app = await launchApp({ files: { "page.html": untrustedPage(remote.origin) } });
  try {
    await app.openFolder();
    await app.openFile("page.html");
    await app.page.click("#html-js");
    await app.waitFor(async () => (await viewerText(app, "#out")) === "ran", {
      message: "the inline script to run",
    });
    await idle(app);
    assert.equal(await viewerColor(app, "#styled"), "rgb(255, 0, 0)");
    assert.deepEqual(remote.hits, [], "scripts must not fetch or load remote resources");
  } finally {
    await app.close();
    await remote.close();
  }
});
