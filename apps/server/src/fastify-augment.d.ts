// 补充 fastify 插件类型增强（修复 @fastify/static / @fastify/websocket 在 fastify 5 下的 module augmentation 失效）
// 根因：这些插件的 declare module 用了与 fastify 5 泛型签名不匹配的声明（1 个泛型 vs 8 个），声明合并不生效。
// 这里用「无泛型」接口增强，TS 会将其合并到对应泛型接口的所有实例上。
import 'fastify';
import type { WebSocket } from 'ws';

declare module 'fastify' {
  interface FastifyReply {
    sendFile(filename: string, rootPath?: string): FastifyReply;
    download(filepath: string, filename?: string): FastifyReply;
  }
  interface RouteShorthandOptions {
    websocket?: boolean;
  }
  // @fastify/websocket 的 websocket handler 重载（其在 fastify 5 下的增强失效）
  interface RouteShorthandMethod {
    (path: string, opts: RouteShorthandOptions & { websocket: true }, handler: (socket: WebSocket, request: FastifyRequest) => void): FastifyInstance;
  }
}