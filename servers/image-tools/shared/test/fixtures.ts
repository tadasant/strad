import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import sharp from "sharp";

export type Paint = (x: number, y: number) => [number, number, number, number];

/** Raw RGBA, painted pixel by pixel. */
export function raw(width: number, height: number, paint: Paint): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out.set(paint(x, y), (y * width + x) * 4);
  }
  return out;
}

export async function png(
  width: number,
  height: number,
  paint: Paint,
): Promise<Buffer> {
  return sharp(Buffer.from(raw(width, height, paint)), {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();
}

export const WHITE: [number, number, number, number] = [255, 255, 255, 255];
export const BLACK: [number, number, number, number] = [0, 0, 0, 255];
export const CLEAR: [number, number, number, number] = [0, 0, 0, 0];

/** A busy, non-repeating texture: template matching needs something to lock on to. */
export const texture: Paint = (x, y) => {
  const v =
    (Math.sin(x * 0.37) * 80 +
      Math.cos(y * 0.23) * 60 +
      ((x * 7 + y * 13) % 31) * 3 +
      128) |
    0;
  return [v & 255, (v * 3) & 255, (x * y) & 255, 255];
};

/** A rectangle of `fill` on `bg`. */
export function rect(
  x0: number,
  y0: number,
  w: number,
  h: number,
  fill = BLACK,
  bg: Paint | [number, number, number, number] = WHITE,
): Paint {
  return (x, y) =>
    x >= x0 && x < x0 + w && y >= y0 && y < y0 + h
      ? fill
      : typeof bg === "function"
        ? bg(x, y)
        : bg;
}

export interface Fixture {
  url: (path: string) => string;
  port: number;
  close: () => Promise<void>;
}

export type Route = (req: IncomingMessage, res: ServerResponse) => void;

/** A loopback HTTP server. The tests reach it through the operator allowlist. */
export async function serve(routes: Record<string, Route>): Promise<Fixture> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const route = routes[path];
    if (!route) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    route(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: (path) => `http://127.0.0.1:${port}${path}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function body(bytes: Buffer, type = "image/png"): Route {
  return (_req, res) => {
    res.setHeader("content-type", type);
    res.end(bytes);
  };
}

function hash(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * A page of TEXT-LIKE lines: 18px line pitch, 9px glyph cells, each glyph a
 * pseudo-random 4×5 bitmap of 2px dots, with word gaps. Every line resembles
 * every other, which is exactly what defeats a downscaled template search, and
 * it needs no fonts on the CI box.
 */
export const textPage: Paint = (x, y) => {
  const line = Math.floor(y / 18);
  const gy = y - line * 18 - 4;
  if (gy < 0 || gy >= 10) return WHITE;
  const cell = Math.floor(x / 9);
  const gx = x - cell * 9 - 1;
  if (gx < 0 || gx >= 8) return WHITE;
  if (hash(line, cell, 0) % 7 === 0) return WHITE; // a space
  const bit = (gy >> 1) * 4 + (gx >> 1);
  return (hash(line, cell, 1) >>> bit) & 1 ? BLACK : WHITE;
};
