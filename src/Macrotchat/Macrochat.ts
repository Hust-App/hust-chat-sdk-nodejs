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

interface IMessageMedia {
  buffer: Buffer;
  contentType: string;
}

enum EStatusCalled {
  Waiting = 'atendimento_pendente',
  Finished = 'atendimento_finalizado',
  Attendance = 'atendimento',
  DepartmentChoice = 'escolha_departamento',
}

interface ICalled {
  id: number;
  user?: IUser;
  connection: IConnection;
  department?: IDepartment;
  contact: IContact;
  dateStart: Date;
  dateEnd?: Date;
  flagFinished: boolean;
  status: EStatusCalled;
}

interface IMessage {
  id: number;
  date: Date;
  send: boolean;
  chatType: string; // Depois alterar para enum
  body?: string;
  connection: IConnection;
  department: IDepartment;
  contact: IContact;
  called: ICalled;
  getMedia: () => Promise<IMessageMedia>;
  // id_contato_fk
}

enum ESendMessageType {
  showNameAttendance,
}

enum EConfig {
  LoadAllCalledInStart,
}

enum EEventsMonitor {
  ChatUser,
  AllChats,
  ConnectionsStatus,
}

declare interface Macrochat {
  on(event: 'message', listener: (result: IMessage) => void): this;

  on(event: 'called:change:user', listener: (result: { newCalled: ICalled; currentCalled: ICalled }) => void): this;

  on(
    event: 'called:change:department',
    listener: (result: { newCalled: ICalled; currentCalled: ICalled }) => void,
  ): this;

  on(event: 'called:change:status', listener: (result: { newCalled: ICalled; currentCalled: ICalled }) => void): this;

  on(event: 'newCalled', listener: (result: ICalled) => void): this;

  on(event: 'websocket:open', listener: () => void): this;
}

class Macrochat extends EventEmitter {
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

  calleds: Array<ICalled> = [];

  protected authInfo: AuthenticationCredentials;

  messageSendConfig: Array<ESendMessageType> = [ESendMessageType.showNameAttendance];

  public config: Array<EConfig> = [];

  public eventsMonitor: Array<EEventsMonitor> = [EEventsMonitor.ChatUser, EEventsMonitor.ConnectionsStatus];

  public conn: WS;

  private async loadDepartments(): Promise<void> {
    const allDepartments: Array<any> = [];
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

      allDepartments.push(...departmentsList);
      return departmentsList;
    };

    this.logger.debug('Realizando busca dos departamentos');

    const {
      data: { ok, mensagem_usuario, departamentos },
    } = await this.api.get(`/departamento/getDepartamentos`, { params: { token: this.authInfo.userToken } });

    if (!ok) throw new Error(`Não foi possível buscar os departamentos [${mensagem_usuario}]`);

    getDepartment(departamentos);
    this.departments = allDepartments;
  }

  private serializeCalled(chamado: any): ICalled {
    const statusEnumType: { [key: string]: EStatusCalled } = {
      atendimento_pendente: EStatusCalled.Waiting,
      atendimento_finalizado: EStatusCalled.Finished,
      atendimento: EStatusCalled.Attendance,
      escolha_departamento: EStatusCalled.DepartmentChoice,
    };

    const {
      atendente,
      conta_nome,
      data,
      data_finalizado,
      flag_finalizado,
      id_chamado,
      id_departamento,
      id_whatsapp,
      status,
    } = chamado;

    // TODO - Algumas buscas estão sendo feitas pelo nome, falha
    const department = this.departments.find(el => el.id === parseFloat(id_departamento));
    const connection = this.connections.find(el => el.accountName === conta_nome);
    const user = this.users.find(el => el.name === atendente);
    const contact = this.contacts.find(el => el.whatsappId === id_whatsapp);

    if (connection && contact) {
      return {
        id: id_chamado,
        department,
        connection,
        user,
        contact,
        dateStart: new Date(data),
        dateEnd: data_finalizado && new Date(data_finalizado),
        flagFinished: !!flag_finalizado,
        status: statusEnumType[status],
      };
    }

    throw new Error(`Chamado sem informação suficiente`);
  }

  async getCalled({
    id,
    dateStart,
    dateEnd,
  }: {
    id?: number;
    dateStart?: Date;
    dateEnd?: Date;
  }): Promise<ICalled | Array<ICalled> | undefined> {
    this.logger.debug('Realizando busca do chamado por parâmetro');

    if (id) {
      const calledLocalSearch = this.calleds.find(el => el.id === id);
      if (calledLocalSearch) return calledLocalSearch;
    }

    const dataPost = {
      token: this.authInfo.userToken,
      protocolo: id,
      periodoInicial: dateStart,
      periodoFinal: dateEnd,
    };

    const {
      data: { ok, mensagem_usuario, chamados },
    } = await this.api.post(`/chamado/getChamados`, dataPost, { timeout: 30 * 1000 });

    if (!ok) throw new Error(`Não foi possível buscar os departamentos [${mensagem_usuario}]`);

    if (chamados.length === 1) return this.serializeCalled(chamados[0]);

    if (chamados.length > 1) {
      const calleds: Array<ICalled> = [];
      for (let i = 0; i < chamados.length; i += 1) {
        try {
          calleds.push(this.serializeCalled(chamados[i]));
        } catch (e) {
          // *
        }
      }

      return calleds;
    }
    return undefined;
  }

  async loadCalleds(): Promise<void> {
    this.logger.debug('Realizando busca dos chamados');

    const dataPost = {
      token: this.authInfo.userToken,
      periodoFinal: new Date(),
      periodoInicial: new Date(new Date().setDate(new Date().getDate() - 30)),
    };

    const {
      data: { ok, mensagem_usuario, chamados },
    } = await this.api.post(`/chamado/getChamados`, dataPost);

    if (!ok) throw new Error(`Não foi possível buscar os chamados [${mensagem_usuario}]`);

    this.calleds = [];

    for (let i = 0; i < chamados.length; i += 1) {
      try {
        this.calleds.push(this.serializeCalled(chamados[i]));
      } catch (e) {
        this.logger.error(`Falha ao carregar chamado [${chamados[i].id_chamado}]`);
      }
    }
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

    this.conn = new WS(`wss://${this.api.defaults.baseURL?.split('/')[2]}:2083`);
    this.conn.on('open', () => {
      this.logger.debug('Conexão WebSocket realizada com sucesso');
      clearInterval(intervalPingPong);

      intervalPingPong = setInterval(
        () => this.conn.readyState === this.conn.OPEN && this.conn.send(JSON.stringify({ metodo: 'ping' })),
        10 * 1000,
      );

      this.logger.debug('Realizando login conexão WebSocket');
      this.conn.send(JSON.stringify({ metodo: 'login', token: this.authInfo.userToken }));
      this.emit('websocket:open');
    });

    this.conn.on('message', async data => {
      const { metodo: method, ...rest } = JSON.parse(data.toString());

      if (method === 'login') {
        const { autenticado: authenticated } = rest;
        if (authenticated) {
          this.logger.info('Login WebSocket realizado com sucesso, conectado e pronto');
          const { eventsMonitor } = this;
          const ChatUser = eventsMonitor.includes(EEventsMonitor.ChatUser) ? 'adicionarEvento' : 'removerEvento';
          const AllChats = eventsMonitor.includes(EEventsMonitor.AllChats) ? 'adicionarEvento' : 'removerEvento';
          const Conn = eventsMonitor.includes(EEventsMonitor.ConnectionsStatus) ? 'adicionarEvento' : 'removerEvento';

          this.conn.send(JSON.stringify({ metodo: ChatUser, evento: 'monitorarChat' }));
          this.conn.send(JSON.stringify({ metodo: AllChats, evento: 'monitorarAllChats' }));
          this.conn.send(JSON.stringify({ metodo: Conn, evento: 'monitorarStatusConexoes' }));
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

        // TODO - Retornar também mensagens enviadas
        // if (flag_enviado) return;

        const connection = this.connections.find(el => el.id === id_whatsapp_conexao_fk);
        const department = this.departments.find(el => el.id === id_departamento);
        let contact = this.contacts.find(el => el.id === id_contato_fk);

        if (!contact) {
          // TODO - Levar para método específico
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

            contact = newContact;
          }
        }

        let called = id_chamado ? await this.getCalled({ id: id_chamado }) : null;
        if (Array.isArray(called)) [called] = called;

        if (!connection || !department || !contact || !called)
          throw new Error(`Mensagem não foi carregada de forma válida.`);

        const message: IMessage = {
          date: new Date(dataMensagem),
          body,
          chatType: tipo_chat,
          send: !!flag_enviado,
          id: id_mensagem,
          connection,
          department,
          contact,
          called,
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

        this.emit('message', message);
      }
    });

    this.conn.on('close', async () => {
      this.logger.error('Conexão com WebSocket perdida, será feito uma nova tentativa em 1 segundo');
      setTimeout(this.connectWS.bind(this), 1000);
    });

    this.conn.on('error', async e => {
      this.logger.error(`Ocorreu um erro na conexão WebSocket ${e.toString()}`);
      // setTimeout(this.connectWS.bind(this), 1000);
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
    if (this.config.indexOf(EConfig.LoadAllCalledInStart) > -1) await this.loadCalleds(); // Depende dos carregamentos anteriores
    // ********************************************
    this.logger.debug(`${this.connections.length} conexões carregados`);
    this.logger.debug(`${this.departments.length} departamentos carregados`);
    this.logger.debug(`${this.contacts.length} contatos carregados`);
    this.logger.debug(`${this.users.length} Usuários carregados`);
    this.logger.debug(`${this.calleds.length} Chamados carregados`);
  }

  async sendMessage({
    number,
    text,
    connection,
    file,
    department,
    contact,
  }: {
    number: string;
    text: string;
    connection?: IConnection;
    file?: { name: string; file: Buffer };
    department?: IDepartment;
    contact?: IContact;
  }): Promise<void> {
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
      numero: !chatID ? number : 'a',
      uuid: connectionToSend.uuid,
      texto: message,
      chatID,
      arquivo: file,
      token: tokenAuthenticated,
      id_departamento_fk: '',
      id_contato: '',
    };

    if (department) data.id_departamento_fk = department.id.toString();
    if (contact) {
      data.chatID = contact.whatsappId;
      data.numero = 'a';
      data.id_contato = contact.id.toString();
      data.token = this.authInfo.userToken;
    }

    this.logger.info(`Enviando nova mensagem para [${number}]`);

    const {
      data: { ok, mensagem_usuario },
    } = await this.api.post(`/whatsapp_api/enviarMensagem`, data);

    if (!ok) throw new Error(mensagem_usuario);
  }

  async transferAttendance({
    id_caller,
    department,
    user,
  }: {
    id_caller: number;
    department: IDepartment;
    user?: IUser;
  }): Promise<void> {
    const {
      data: { ok },
    } = await this.api.post(`/chamado/transferirAtendimento`, {
      id_chamado: id_caller,
      id_departamento: department.id,
      id_usuario: user?.id,
      token: this.authInfo.userToken,
    });

    if (!ok) throw new Error(`Não foi possível transferir o atendimento`);
  }

  startCalledMonitor(time = 30): void {
    let running = false;
    setInterval(async () => {
      try {
        if (!running) {
          running = true;
          const calleds = await this.getCalled({
            dateStart: new Date(new Date().setDate(new Date().getDate() - 1)),
            dateEnd: new Date(),
          });

          if (calleds && Array.isArray(calleds)) {
            for (let i = 0; i < calleds.length; i += 1) {
              const newCalled = calleds[i];
              const currentCalledKey = this.calleds.map(prop => prop.id).indexOf(newCalled.id);
              const currentCalled = this.calleds[currentCalledKey];
              if (currentCalled) {
                if (newCalled.user?.id !== currentCalled.user?.id)
                  this.emit('called:change:user', {
                    newCalled,
                    currentCalled,
                  });

                if (newCalled.department?.id !== currentCalled.department?.id)
                  this.emit('called:change:department', { newCalled, currentCalled });

                if (newCalled.status !== currentCalled.status)
                  this.emit('called:change:status', { newCalled, currentCalled });

                this.calleds[currentCalledKey] = newCalled;
              } else {
                this.calleds.push(calleds[i]);
                this.emit('newCalled', calleds[i]);
              }
            }
          }
        }
      } finally {
        running = false;
      }
    }, time * 1000);
  }

  async finishAttendance({ called, flagSilent }: { called: ICalled; flagSilent?: boolean }): Promise<void> {
    await this.api.get(`/chamado/finalizarChamado`, {
      params: {
        id_chamado: called.id,
        flag_silencioso: flagSilent,
        token: this.authInfo.userToken,
      },
    });
  }

  async getContactInfo(number: string): Promise<any> {
    const params = { numero: number, token: this.authInfo.userToken };
    const { data } = await this.api.get(`/contato/getContatoInfo`, { params });

    const { ok, mensagem_usuario, descricao_usuario, contato } = data;

    if (!ok) throw new Error(`${mensagem_usuario}${descricao_usuario}`);

    return contato;
  }

  async registerPhone(number: string, name: string): Promise<void> {
    const contact = await this.getContactInfo(number);

    const dataPost = { id_contato: contact.id_contato, nome: (name || '').trim(), token: this.authInfo.userToken };
    await this.api.post(`/contato/cadastrarContato`, dataPost);
  }
}

export default Macrochat;
export {
  MCConnectionState,
  EStatusCalled,
  ESendMessageType,
  EConfig,
  EEventsMonitor,
  EDeviceState,
  IConnection,
  IDepartment,
  IUser,
  IContact,
  ICalled,
};
