// Servidor WebSocket mínimo (RFC 6455) usando apenas módulos nativos do Node.
// Suficiente para o nosso caso: fazer broadcast de mensagens de texto (JSON)
// do servidor para os navegadores conectados. Sem dependências externas.
import crypto from "crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class WSHub {
  constructor() {
    this.clients = new Set();
  }

  handleUpgrade(req, socket) {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);
    this.clients.add(socket);

    const cleanup = () => {
      this.clients.delete(socket);
      socket.destroy();
    };

    // Leitura mínima só para detectar close/ping do cliente.
    socket.on("data", (buf) => {
      try {
        const opcode = buf[0] & 0x0f;
        if (opcode === 0x8) cleanup(); // close
      } catch {
        cleanup();
      }
    });
    socket.on("error", cleanup);
    socket.on("close", () => this.clients.delete(socket));

    return {
      send: (str) => this._send(socket, str),
    };
  }

  _encode(str) {
    const payload = Buffer.from(str, "utf8");
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
  }

  _send(socket, str) {
    try {
      if (socket.writable) socket.write(this._encode(str));
    } catch {
      this.clients.delete(socket);
    }
  }

  broadcast(obj) {
    const frame = this._encode(typeof obj === "string" ? obj : JSON.stringify(obj));
    for (const socket of this.clients) {
      try {
        if (socket.writable) socket.write(frame);
        else this.clients.delete(socket);
      } catch {
        this.clients.delete(socket);
      }
    }
  }
}
