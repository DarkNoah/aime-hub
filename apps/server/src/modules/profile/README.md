# 用户头像

- `POST /api/profile/avatar`：已登录用户上传 multipart `file`，校验受信任的 `Origin`，最多 10 MiB。只解码 JPEG、PNG、WebP，限制输入像素并去除图片元数据，统一输出 512×512 WebP。
- `GET/HEAD /api/resources/avatars/<SHA-256>.webp`：公开读取，无需会话，允许跨站图片展示。只接受固定格式的文件名，不提供目录或任意文件路径访问。
- 文件保存在 `WORKSPACE_ROOT/.resources/avatars/`，数据库的 Better Auth `users.image` 只存 URL。部署及备份需保留此目录；沿用现有工作区持久卷。
- 文件名由压缩后的内容决定，发布时原子写入，相同内容复用文件。换图生成新 URL，响应使用 `public, max-age=31536000, immutable`、ETag、Last-Modified，支持 304。404 不缓存。
- 前端先使用 `react-image-crop` 裁剪和预览，保存资料时才上传。圆形选区对应正方形图像，圆形显示由 Avatar 组件完成。资料仍通过 Better Auth `updateUser` 保存和刷新会话。
- 更换或移除头像不会立即删除历史资源，以免破坏已缓存或已引用的 URL。公开资源路由不提供删除入口。

验证：`node --import tsx --test scripts/profile-avatars.test.ts`，覆盖压缩、缓存、条件请求、匿名访问、上传鉴权、非法图片、大小限制和路径边界。
