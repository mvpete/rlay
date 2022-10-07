import * as express from "express";
import * as http from "http";
import * as path from "path";
import * as url from "url"
import { v4 as uuidv4 } from "uuid";
import { Server, Socket } from "socket.io";

import { ServerConfiguration } from "./ServerConfiguration";
import { HttpRequest, HttpResponse } from "../../common/src";
import { Logger } from "./Logger";

const ERROR_NO_CONNECTION = "No socket connected";
const MAX_LOGS_DEFAULT = 50;

interface CallLog {
  date: Date,
  request?: HttpRequest,
  response?: HttpResponse
}

interface State {
  client: {
    connected: boolean
  },
  captureLogs: boolean,
  version: string
}

export class RlayHttpServer {
  sockets: Map<string, Socket> = new Map<string, Socket>();

  private logs: CallLog[] = []
  private maxLogs = MAX_LOGS_DEFAULT
  private captureLogs = false

  constructor(private config: ServerConfiguration, private logger: Logger) {
    const server = this.createServer();
    server.listen(this.config.port.http, () => {
      this.logger.info(`Listening for HTTP requests on ${this.config.port.http}`);
    });
  }

  private addCallLog(log: CallLog) {
    if (this.captureLogs) {
      this.logs.push(log)
      while (this.logs.length > this.maxLogs) {
        this.logs.shift()
      }
    }
  }

  private createServer() {
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, {
      maxHttpBufferSize: 1e15
    });
    io.on("connection", this.handleNewConnection.bind(this));
    app.use("/rlay", express.static(path.join(__dirname, "static")))
    app.get("/rlay/:id/calls", this.getCalls.bind(this))
    app.delete("/rlay/:id/calls", this.deleteCalls.bind(this))
    app.get("/rlay/login", this.login.bind(this))
    app.get("/rlay/:id/state", this.getState.bind(this))
    app.patch("/rlay/:id/state", this.patchState.bind(this))
    app.all("*", this.handleRequest.bind(this));
    return server;
  }

  private login(req: express.Request, res: express.Response) {
    if (req.headers["password"] !== this.config.password) {
      res.statusCode = 403
      res.send(JSON.stringify("Wrong password"))
      return;
    }
    res.send('{"status": "success"}')
  }

  private getCalls(req: express.Request, res: express.Response) {
    if (req.headers["password"] !== this.config.password) {
      res.statusCode = 403
      res.send(JSON.stringify("Wrong password"))
      return
    }
    res.contentType("application/json")
    res.write(JSON.stringify(this.logs, null, 2))
    res.send()
  }

  private deleteCalls(req: express.Request, res: express.Response) {
    if (req.headers["password"] !== this.config.password) {
      res.statusCode = 403
      res.send(JSON.stringify("Wrong password"))
      return
    }
    this.logs = []
    res.send()
  }

  private getState(req: express.Request, res: express.Response) {
    if (req.headers["password"] !== this.config.password) {
      res.statusCode = 403
      res.send(JSON.stringify("Wrong password"))
      return
    }
    res.contentType("application/json")
    const state: State = {
      client: {
        connected: this.sockets.has(req.params.id),
      },
      captureLogs: this.captureLogs,
      version: this.config.version
    }
    res.write(JSON.stringify(state, null, 2))
    res.send()
  }



  private async patchState(req: express.Request, res: express.Response) {
    if (req.headers["password"] !== this.config.password) {
      res.statusCode = 403
      res.send(JSON.stringify("Wrong password"))
      return
    }

    const body = await this.getRequestBodyAsync(req, false)
    const patchRequest = JSON.parse(body.toString()) as Partial<State>
    if (patchRequest.captureLogs !== undefined) {
      this.captureLogs = patchRequest.captureLogs
    }
    res.send("{}")
  }

  private handleNewConnection(newSocket: Socket) {
    this.logger.info(`Client connection request`);
    if (newSocket.handshake.auth.password !== this.config.password) {
      this.logger.error(`Password does not match. Rejecting connection`);
      newSocket.emit("incorrect password");
      newSocket.disconnect(true);
      return;
    }

    const sockId = uuidv4();
    this.sockets.set(sockId, newSocket);
    const socket = newSocket;

    this.logger.info(`Connected client ${sockId}`);
    socket.on("disconnect", (err: any) => {
      this.logger.info(`Client disconnected: ${err}`);
      this.sockets.delete(sockId);
    });
    socket.on("error", (err: any) => {
      this.logger.error(`Socket error: ${err}`);
    })

    socket.emit("connect complete", sockId);
  }

  private handleRequest(req: express.Request, res: express.Response) {
    this.logger.debug(`Received new request`)
    console.log(req.hostname);
    if (req.path.indexOf("socket.io") >= 0) {
      this.logger.debug(`Socket connection - leaving that to socket.io`)
      return;
    }
    const log: CallLog = {
      date: new Date(),
    }
    this.addCallLog(log)
    this.getRequestBodyAsync(req)
      .then((body) => {
        const requestId = uuidv4();
        const size = body.byteLength
        const request: HttpRequest = {
          method: req.method,
          path: req.originalUrl.replace(`/${req.params.id}`,""),
          body: body.toString("base64"),
          headers: req.rawHeaders,
          id: requestId,
          bodySize: size,
          sockId: req.hostname.substring(0,req.hostname.indexOf('.')),
        };
        log.request = request
        return request;
      })
      .then(this.forwardRequestToRlayClientAsync.bind(this))
      .then((response) => {
        log.response = response
        this.forwardResponseToCaller(response, res)
      })
      .catch((error) => this.handleRlayClientError(error, res));
  }

  private getRequestBodyAsync(req: express.Request, log = false): Promise<Buffer> {
    return new Promise((resolve) => {
      log && this.logger.debug(`Collecting request body`)
      let body = Buffer.from([]);
      req.on("data", (chunk) => {
        log && this.logger.debug(`Collected data for request body`)
        body = Buffer.concat([body, chunk])
      });
      req.on("end", () => {
        log && this.logger.debug(`Request body complete`)
        resolve(body)
      });
    });
  }

  private forwardResponseToCaller(response: HttpResponse, res: express.Response) {
    this.logger.debug(`Forwarding response to caller`)
    this.copyHeaders(response, res);
    res.statusCode = response.statusCode;
    if (response.body) {
      const responseBody = Buffer.from(response.body, "base64")
      response.bodySize = responseBody.byteLength
      res.write(responseBody);
    }
    res.send();
    this.logger.debug(`Done forwarding response`)
  }

  private copyHeaders(response: HttpResponse, res: express.Response) {
    this.logger.debug(`Copying headers`)
    Object.keys(response.headers).forEach((key) => {
      res.setHeader(key, response.headers[key]);
    });
  }

  private forwardRequestToRlayClientAsync(request: HttpRequest): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {

      console.log(`Request on socket: ${request.sockId}`);
      const socket : Socket | undefined = this.sockets.get(request.sockId);

      if (socket == null){
        this.logger.error(`Tried to forward request, but no client connected`)
        return reject(Error(ERROR_NO_CONNECTION));
      }

      this.logger.info(`Transmitting request ${request.id}`);
      socket.emit("request received", request);
      socket.once(`response for ${request.id}`, (response: HttpResponse) => {
        this.logger.info(`Received response`);
        resolve(response);
      });
    });
  }

  private handleRlayClientError(
    error: any,
    res: express.Response<any, Record<string, any>>
  ) {
    if (error.message === ERROR_NO_CONNECTION) {
      res.statusCode = 502;
      res.send("No client connected");
      this.logger.error("Request received but no client connected");
    } else {
      res.statusCode = 503;
      res.send(error);
      this.logger.error("Other error: " + error);
    }
  }
}
