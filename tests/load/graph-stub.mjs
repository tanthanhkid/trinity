#!/usr/bin/env node
/**
 * Máy chủ giả "Graph treo" cho ca tải X05: nhận kết nối rồi KHÔNG trả lời (giữ socket mở).
 *
 *   PORT=9911 node tests/load/graph-stub.mjs
 *
 * Trỏ Trinity vào đây bằng `FACEBOOK_GRAPH_BASE_URL=http://127.0.0.1:9911` (http chỉ được phép cho loopback).
 */
import http from 'node:http';

const port = Number(process.env.PORT ?? 9911);
const open = new Set();
http
  .createServer((req) => {
    open.add(req.socket);
    req.socket.on('close', () => open.delete(req.socket));
    // cố ý không gọi res.end()
  })
  .listen(port, '127.0.0.1', () => console.log(`graph-stub treo ở 127.0.0.1:${port}`));
setInterval(() => console.log(`socket đang treo: ${open.size}`), 10000).unref();
