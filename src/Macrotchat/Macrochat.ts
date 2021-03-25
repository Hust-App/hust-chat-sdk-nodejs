import { EventEmitter } from 'events';
import WS from 'ws';
import pino from 'pino';
import axios, { AxiosInstance } from 'axios';

const logger = pino({
  prettyPrint: { levelFirst: true, ignore: 'hostname', translateTime: true },
});

enum MCConnectionState {
  close,
  open,
}

interface AuthenticationCredentials {
  user: string;
  password: string;
  userToken?: string;
}

enum EDeviceState {
  active,
  anotherTab,
  disconnectedInternet,
  disconnected,
}

interface IDeviceStatus {
  state: EDeviceState;
  battery: { level: number; charging: boolean };
}

interface IConnection {
  accountDevice: string;
  accountName: string;
  accountNumber: string;
  active: boolean;
  id: number;
  uuid: string;
  deviceStatus: IDeviceStatus;
}

interface IDepartment {
  internal: boolean;
  id: number;
  name: string;
  subDepartment?: IDepartment;
}

interface IContact {
  id: number;
  name: string;
  profilePicture: string;
  whatsappId: string;
}

interface IUser {
  id: number;
  email: string;
  admin: boolean;
  profilePicture: string;
  departments: Array<IDepartment>;
  name: string;
}

interface ICaller {
  id: number;
}

interface IMessageMedia {
  buffer: Buffer;
  contentType: string;
}

interface IMessage {
  id: number;
  date: Date;
  send: boolean;
  chatType: string; // Depois alterar para enum
  body?: string;
  connection?: IConnection;
  department?: IDepartment;
  contact?: IContact;
  caller?: ICaller;
  getMedia?: () => Promise<IMessageMedia>;
  // id_contato_fk
}

enum ESendMessageType {
  showNameAttendance,
}

export default class Macrochat extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(30);
  }

  api: AxiosInstance = axios.create({ baseURL: `https://api.macrochat.com.br/v1` });

  logger = logger.child({});

  state: MCConnectionState = MCConnectionState.close;

  connections: Array<IConnection> = [];

  departments: Array<IDepartment> = [];

  users: Array<IUser> = [];

  contacts: Array<IContact> = [];

  protected authInfo: AuthenticationCredentials;

  messageSendConfig: Array<ESendMessageType> = [ESendMessageType.showNameAttendance];

  // @ts-ignore
  on(event: 'message', listener: (result: IMessage) => void): this;

  protected conn: WS;

  async loadDepartments(): Promise<void> {
    const getDepartment = (departamentos: Array<any>): Array<IDepartment> => {
      const departmentsList: Array<IDepartment> = [];

      for (let i = 0; i < departamentos.length; i += 1) {
        const { id_departamento, nome, flag_departamento_interno, subDepartamentos } = departamentos[i];

        departmentsList.push({
          id: id_departamento,
          internal: !!flag_departamento_interno,
          name: nome,
          subDepartment: subDepartamentos && getDepartment(subDepartamentos),
        });

        if (!departmentsList[i].subDepartment) delete departmentsList[i].subDepartment;
      }

      return departmentsList;
    };

    this.logger.debug('Realizando busca dos departamentos');

    const {
      data: { ok, mensagem_usuario, departamentos },
    } = await this.api.get(`/departamento/getDepartamentos`, { params: { token: this.authInfo.userToken } });

    if (!ok) throw new Error(`Não foi possível buscar os departamentos [${mensagem_usuario}]`);

    this.departments = getDepartment(departamentos);
  }

  async loadContacts(): Promise<void> {
    this.logger.debug('Realizando busca dos contatos');

    const {
      data: { ok, mensagem_usuario, contatos },
    } = await this.api.get(`/contato/getContatos`, { params: { token: this.authInfo.userToken } });

    if (!ok) throw new Error(`Não foi possível buscar os departamentos [${mensagem_usuario}]`);

    this.contacts = [];

    for (let i = 0; i < contatos.length; i += 1) {
      const { foto_perfil, id_contato, id_whatsapp, nome } = contatos[i];
      this.contacts.push({ name: nome, id: id_contato, profilePicture: foto_perfil, whatsappId: id_whatsapp });
    }
  }

  async loadUsers(): Promise<void> {
    this.logger.debug('Realizando busca dos usuários');

    const {
      data: { ok, mensagem_usuario, usuarios },
    } = await this.api.get(`/usuario/getUsuarios`, { params: { token: this.authInfo.userToken } });

    if (!ok) throw new Error(`Não foi possível buscar os usuários [${mensagem_usuario}]`);

    this.users = [];

    for (let i = 0; i < usuarios.length; i += 1) {
      const { email, flag_gestor, foto_perfil, id_departamento_fk, id_usuario, nome } = usuarios[i];
      const departmentsUser = id_departamento_fk.toString().split(',').map(parseFloat);

      const departments: Array<IDepartment> = [];
      for (let j = 0; j < departmentsUser.length; j += 1) {
        const systemDepartment = this.departments.find(el => el.id === departmentsUser[j]);
        if (systemDepartment) departments.push(systemDepartment);
      }

      this.users.push({
        name: nome,
        id: id_usuario,
        profilePicture: foto_perfil,
        admin: !!flag_gestor,
        email,
        departments,
      });
    }
  }

  async loadConnections(): Promise<void> {
    this.logger.debug('Realizando busca das conexões');
    const {
      data: { ok, mensagem_usuario, whatsapp_conexao },
    } = await this.api.get(`/whatsapp_api/getConexoes`, { params: { token: this.authInfo.userToken } });

    if (!ok) throw new Error(`Não foi possível buscar as conexões [${mensagem_usuario}]`);

    this.connections = [];

    for (let i = 0; i < whatsapp_conexao.length; i += 1) {
      const {
        conta_marca_celular,
        conta_nome,
        conta_numero,
        flag_ativo,
        id_whatsapp_conexao,
        status: { carregando, celularDesconectadoInternet, desconectado, nivelBateria, outraAba },
        uuid,
      } = whatsapp_conexao[i];

      this.connections.push({
        uuid,
        accountDevice: conta_marca_celular,
        accountName: conta_nome,
        accountNumber: conta_numero,
        active: !!flag_ativo,
        id: id_whatsapp_conexao,
        deviceStatus: {
          battery: { charging: carregando, level: nivelBateria },
          state: EDeviceState.active,
        },
      });

      switch (true) {
        case celularDesconectadoInternet:
          this.connections[i].deviceStatus.state = EDeviceState.disconnectedInternet;
          break;
        case desconectado:
          this.connections[i].deviceStatus.state = EDeviceState.disconnected;
          break;
        case outraAba:
          this.connections[i].deviceStatus.state = EDeviceState.anotherTab;
          break;
        default:
          this.connections[i].deviceStatus.state = EDeviceState.active;
          break;
      }
    }
  }

  async connectWS(): Promise<void> {
    let intervalPingPong: NodeJS.Timeout;

    this.logger.debug('Inicializando conexão WebSocket');

    this.conn = new WS(`wss://${this.api.defaults.baseURL?.split('/')[2]}:19548`);
    this.conn.on('open', () => {
      this.logger.debug('Conexão WebSocket realizada com sucesso');
      clearInterval(intervalPingPong);
      intervalPingPong = setInterval(() => this.conn.send(JSON.stringify({ metodo: 'ping' })), 10 * 1000);
      this.logger.debug('Realizando login conexão WebSocket');
      this.conn.send(JSON.stringify({ metodo: 'login', token: this.authInfo.userToken }));
    });

    this.conn.on('message', async data => {
      const { metodo: method, ...rest } = JSON.parse(data.toString());

      if (method === 'login') {
        const { autenticado: authenticated } = rest;
        if (authenticated) {
          this.logger.info('Login WebSocket realizado com sucesso, conectado e pronto');

          this.conn.send(JSON.stringify({ metodo: 'adicionarEvento', evento: 'monitorarChat' }));
          this.conn.send(JSON.stringify({ metodo: 'adicionarEvento', evento: 'monitorarStatusConexoes' }));
        } else this.logger.error('Falha na autenticação WebSocket');
      }

      if (method === 'statusConexao') {
        // const { uuid } = rest;
      }

      if (rest.id_mensagem_whatsapp) {
        const {
          data: dataMensagem,
          id_mensagem,
          flag_enviado,
          id_whatsapp_conexao_fk,
          body,
          id_departamento,
          id_contato_fk,
          tipo: tipo_chat,
          id_chamado,
        } = rest;

        if (flag_enviado) return;

        const message: IMessage = {
          date: new Date(dataMensagem),
          body,
          chatType: tipo_chat,
          send: !!flag_enviado,
          id: id_mensagem,
          connection: this.connections.find(el => el.id === id_whatsapp_conexao_fk),
          department: this.departments.find(el => el.id === id_departamento),
          contact: this.contacts.find(el => el.id === id_contato_fk),
          caller: { id: id_chamado },
          getMedia: async () => {
            const { data: media, headers } = await this.api.get(`/chat/getMediaFromMessageID`, {
              params: { token: this.authInfo.userToken, id_mensagem },
              responseType: 'arraybuffer',
            });

            return {
              buffer: media,
              contentType: headers['content-type'],
            };
          },
        };

        if (!message.contact) {
          const {
            data: { ok, contato },
          } = await this.api.get(`/contato/getContato`, {
            params: { id_contato: id_contato_fk, token: this.authInfo.userToken },
          });

          if (ok) {
            const { id_whatsapp, foto_perfil, nome, id_contato } = contato;

            const newContact: IContact = {
              id: id_contato,
              whatsappId: id_whatsapp,
              name: nome,
              profilePicture: foto_perfil,
            };

            this.contacts.push(newContact);

            message.contact = newContact;
          }
        }

        this.emit('message', message);
      }
    });

    this.conn.on('close', async () => {
      this.logger.error('Conexão com WebSocket perdida, será feito uma nova tentativa em 1 segundo');
      setTimeout(this.connectWS, 1000);
    });
  }

  async login({ user, password }: AuthenticationCredentials): Promise<void> {
    // class AuthenticationError extends Error {}

    this.authInfo = { user, password };

    this.logger.debug('Realizando login Macrochat');

    const {
      // data: { ok, mensagem_usuario, token, flag_gestor, flag_revenda },
      data: { ok, mensagem_usuario, token },
    } = await this.api.post(`/login/login`, { email: user, senha: password });

    if (!ok) {
      this.logger.error(`Não foi possível realizar login [${mensagem_usuario}]`);
      throw new Error(mensagem_usuario);
    }

    this.logger.info('Autenticação de conta realizado com sucesso');

    this.authInfo.userToken = token;

    // ********************************************
    await this.connectWS();
    await Promise.all([this.loadConnections(), this.loadDepartments(), this.loadContacts()]);
    await this.loadUsers(); // Depende do carregamento de departamentos
    // ********************************************
    this.logger.debug(`${this.connections.length} conexões carregados`);
    this.logger.debug(`${this.departments.length} departamentos carregados`);
    this.logger.debug(`${this.contacts.length} contatos carregados`);
    this.logger.debug(`${this.users.length} Usuários carregados`);
  }

  async sendMessage({
    number,
    text,
    connection,
    file,
  }: {
    number: string;
    text: string;
    connection?: IConnection;
    file?: { name: string; file: Buffer };
  }): Promise<void> {
    if (['@g.us'].indexOf(number) > -1) return;

    const chatID = number.indexOf('@') > -1 ? number : undefined;
    let message = text;

    let connectionToSend: IConnection = this.connections.filter(el => el.active)[0];

    if (!connectionToSend || (connection && !connection.active))
      throw new Error(`Nenhuma conexão ativa para envio da mensagem`);

    if (connection) connectionToSend = connection;

    let tokenAuthenticated = this.authInfo.userToken;

    if (this.messageSendConfig.indexOf(ESendMessageType.showNameAttendance) === -1) tokenAuthenticated = undefined;

    if (file) tokenAuthenticated = undefined;

    if (tokenAuthenticated) message = `\n${message}`;

    const data = {
      numero: number,
      uuid: connectionToSend.uuid,
      texto: message,
      chatID,
      arquivo: file,
      token: tokenAuthenticated,
    };

    this.logger.info(`Enviando nova mensagem para [${number}]`);

    const {
      data: { ok, mensagem_usuario },
    } = await this.api.post(`/whatsapp_api/enviarMensagem`, data);

    if (!ok) throw new Error(mensagem_usuario);
  }

  async transferAttendance({ id_caller, department }: { id_caller: number; department: IDepartment }): Promise<void> {
    // TODO - Transferir para usuário específico

    const {
      data: { ok },
    } = await this.api.post(`/chamado/transferirAtendimento`, {
      id_chamado: id_caller,
      id_departamento: department.id,
      token: this.authInfo.userToken,
    });

    if (!ok) throw new Error(`Não foi possível transferir o atendimento`);
  }
}
