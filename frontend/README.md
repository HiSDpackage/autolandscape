# GitHub Pages 前端

将 `frontend/` 和根目录 `.github/workflows/pages.yml` 放入 `HiSDpackage/autolandscape` 仓库。
Settings -> Pages -> Source: GitHub Actions。部署地址为 `https://hisdpackage.github.io/autolandscape/`。

`config.js` 默认指向 `https://api.autolandscape.win`。变更API域名时同步修改 `index.html` 的 CSP connect-src。变更网页主机时修改 Cloudflare ALLOWED_ORIGINS。

不需要npm构建，不需要第三方CDN。令牌仅保存在页面内存，刷新需重新输入。所有动态文字通过 textContent 渲染，结果图片先鉴权下载成Blob，不将令牌写入URL。CORS是浏览器约束，后端仍独立做令牌鉴权与所有权检查。

表单修改后点击“写入 JSON”；高级JSON是最终发送内容。AI未开通时模板、确认、计算、状态和文件下载仍可用。
