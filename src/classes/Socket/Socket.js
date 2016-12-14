import log4js from 'log4js';
import {Address} from '../Address';
import {Crypto, CRYPTO_IV_LEN} from '../Crypto';
import {Config} from '../Config';
import {Encapsulator} from '../Encapsulator';
import {TcpRelay, UdpRelay} from '../Relay';

import {
  IdentifierMessage,
  SelectMessage,
  RequestMessage,
  ReplyMessage,
  UdpRequestMessage
} from '../../socks5';

import {
  REQUEST_COMMAND_CONNECT,
  REQUEST_COMMAND_UDP,
  REPLY_SUCCEEDED,
  REPLY_COMMAND_NOT_SUPPORTED
} from '../../socks5/Constants';

const Logger = log4js.getLogger('Socket');

export class Socket {

  _id = null;

  _socket = null;

  _tcpRelay = null;

  _udpRelay = null;

  _socksTcpReady = false;

  _socksUdpReady = false;

  _targetAddress = null;

  _decipher = null;

  _cipher = null;

  _iv = null;

  constructor({id, socket}) {
    Logger.setLevel(Config.log_level);
    this._id = id;
    this._socket = socket;
    this.updateCiphers();
    // events
    socket.on('error', (err) => this.onError(socket, err));
    socket.on('close', (had_error) => this.onClose(socket, had_error));
    socket.on('data', (buffer) => this.onReceiving(socket, buffer));
    Logger.info(`client[${this._id}] connected`);
  }

  obtainIV(buffer) {
    if (buffer.length < CRYPTO_IV_LEN + 9) {
      if (Logger.isFatalEnabled()) {
        Logger.fatal(`cannot obtain iv from client, packet is too small (${buffer.length}bytes)`);
      }
      return null;
    }
    return buffer.slice(-CRYPTO_IV_LEN);
  }

  updateCiphers() {
    const collector = (buffer) => this.onReceived(buffer);
    const iv = this._iv === null ? undefined : this._iv;
    this._cipher = Crypto.createCipher(collector, iv);
    this._decipher = Crypto.createDecipher(collector, iv);
  }

  getRelay() {
    // return tcp relay
    if (this._socksTcpReady || Config.isServer) {
      return this._tcpRelay = this._tcpRelay ||
        new TcpRelay({
          id: this._id,
          socket: this._socket
        });
    }
    // return udp relay
    if (this._socksUdpReady || Config.isServer) {
      return this._udpRelay = this._udpRelay ||
        new UdpRelay({
          id: this._id,
          socket: this._socket
        });
    }
    return null;
  }

  onReceiving(socket, buffer) {
    if (Config.isServer) {
      this._decipher.write(buffer);
    } else {
      // socks5 handshake, client only
      if (!this._socksTcpReady && !this._socksUdpReady) {
        this.onSocksHandshake(socket, buffer);
        return;
      }

      let _buffer = buffer;
      if (this._socksUdpReady) {
        const request = UdpRequestMessage.parse(buffer);
        if (request !== null) {
          // just drop RSV and FRAG
          _buffer = request.DATA;
        } else {
          if (Logger.isWarnEnabled()) {
            Logger.warn(`[${this._id}] -x-> dropped unidentified packet ${buffer.length} bytes`);
          }
          return;
        }
      }

      // send with iv, if needed
      if (this._iv === null && Config.use_iv) {
        // 1. generate iv for each connection
        this._iv = Crypto.generateIV();
        // 2. pack then send out
        this._cipher.write(Encapsulator.pack(this._targetAddress, Buffer.concat([_buffer, this._iv])).toBuffer());
        // 3. update socket ciphers
        this.updateCiphers();
        // 4. update relay ciphers
        this.getRelay().setIV(this._iv);
      } else {
        // send without iv
        this._cipher.write(Encapsulator.pack(this._targetAddress, _buffer).toBuffer());
      }
    }
  }

  onReceived(buffer) {
    const relay = this.getRelay();
    if (Config.isServer) {
      // obtain iv from the first packet if needed
      if (this._iv === null && Config.use_iv) {
        this._iv = this.obtainIV(buffer);
        if (this._iv === null) {
          this._socket.end();
          this._socket.destroy();
          return;
        }
        // TODO(refactor): simplify the post-process to buffer
        const buf = buffer.slice(0, buffer.length - CRYPTO_IV_LEN);
        const newLen = Encapsulator.numberToArray(buf.readUInt16BE(0) - CRYPTO_IV_LEN);
        buf[0] = newLen[0];
        buf[1] = newLen[1];
        relay.setIV(this._iv);
        relay.forwardToDst(buf);
        this.updateCiphers();
        return;
      }
      relay.forwardToDst(buffer);
    } else {
      relay.forwardToServer(buffer);
    }
  }

  onError(socket, err) {
    switch (err.code) {
      case 'ECONNRESET':
        Logger.warn(`client[${this._id}] ${err.message}`);
        return;
      case 'EPIPE':
        Logger.warn(`client[${this._id}] ${err.message}`);
        return;
      default:
        Logger.error(err);
        break;
    }
  }

  onClose(socket, had_error) {
    if (had_error) {
      Logger.warn(`client[${this._id}] closed due to a transmission error`);
    } else {
      Logger.info(`client[${this._id}] closed normally`);
    }
    if (this._tcpRelay !== null) {
      this._tcpRelay.close();
    }
  }

  onSocksHandshake(socket, buffer) {
    // 1. IDENTIFY
    const identifier = IdentifierMessage.parse(buffer);
    if (identifier !== null) {
      const message = new SelectMessage();
      socket.write(message.toBuffer());
      return;
    }

    // 2. REQUEST
    const request = RequestMessage.parse(buffer);
    if (request !== null) {
      const type = request.CMD;
      switch (type) {
        case REQUEST_COMMAND_UDP: // UDP ASSOCIATE
        case REQUEST_COMMAND_CONNECT: {
          this._targetAddress = new Address({
            ATYP: request.ATYP,
            DSTADDR: request.DSTADDR,
            DSTPORT: request.DSTPORT
          });

          // reply success
          const message = new ReplyMessage({REP: REPLY_SUCCEEDED});
          socket.write(message.toBuffer());

          if (type === REQUEST_COMMAND_CONNECT) {
            this._socksTcpReady = true;
          } else {
            this._socksUdpReady = true;
          }
          break;
        }
        default: {
          const message = new ReplyMessage({REP: REPLY_COMMAND_NOT_SUPPORTED});
          socket.write(message.toBuffer());
          break;
        }
      }
    }
  }

}
