# [Macrotix - Macrochat SDK - NodeJS](https://macrochat.com.br)

![version](https://img.shields.io/badge/Vers%C3%A3o-1.0.0-blue.svg)
![version](https://img.shields.io/badge/Node%20Version-v12.9.1-green.svg)

## Sobre

SDK em NodeJS com Typescript para auxílio no desenvolvimento das integrações com o Macrochat.

## Estrutura

```
├── Helper
|   └── Functions
|       ├── zeroEsquerda
|       └── Timeout
└─ Macrochat
    ├── Funções
    |   ├── login
    |   ├── sendMessage
    |   └── transferAttendance
    └── Propriedades
        ├── connections
        ├── departments
        ├── users
        └── contacts
```

## Eventos
Para usar os eventos é preciso iniciar o monitoramento com o comando: `startCalledMonitor(time)`

```typescript
/** Quando uma nova mensagem é recebida **/
on('message')

/** Quando um chamado muda de atendente **/
on('called:change:user')

/** Quando um chamado muda de departamento **/
on('called:change:department')

/** Quando um atendimento muda de status **/
on('called:change:status')

/** Quando um novo chamado é iniciado **/
on('newCalled')
```

## Principais comandos
```typescript
/** Retorna um atendimento específico ou por período **/
MC.getCalled({ id?: number; dateStart?: Date; dateEnd?: Date; });

/** Envia uma mensagem ou mídia **/
MC.sendMessage({
  number: string;
  text: string;
  connection?: IConnection;
  file?: { name: string; file: Buffer };
  department?: IDepartment;
  contact?: IContact;
});

/** Transfere um atendimento **/
transferAttendance({ id_caller: number; department: IDepartment; user?: IUser; });

/** Finaliza um atendimento **/
async finishAttendance({ called: ICalled; flagSilent?: boolean });

```

## Exemplo de uso

```typescript
import Macrochat from '@macrotix-tecnologia/macrotix-sdk-nodejs';

(async () => {
  const MC = new Macrochat();

  MC.logger.level = 'debug';

  MC.messageSendConfig = [];

  await MC.login({ user: 'usuario@macrotix.com.br', password: 'SENHA' });

  MC.on('message', async messageReceived => {
    try {
      if (['ptt', 'audio', 'chat'].indexOf(message.chatType) === -1) {
        await MC.sendMessage({
          number: message.contact.whatsappId,
          text: `😔Ainda não consigo responder a este tipo de mensagem.\nGrave um áudio ou mande uma mensagem de texto!`,
        });

        return;
      }

      if (['ptt', 'audio'].indexOf(message.chatType) > -1) {
        const { buffer, contentType } = await message.getMedia();

        await MC.sendMessage({
          number: message.contact.whatsappId,
          text: `Audio recebido e baixado!`
        });

        return;
      }

      if (message.chatType === 'chat') {
        const departmentSelected = MC.departments.find(el => el.name.indexOf(message.body.toString()) > -1);
        if (departmentSelected) {
          await MC.transferAttendance({ id_caller: message.caller.id, department: departmentSelected });
          return;
        }

        await MC.sendMessage({
          number: message.contact.whatsappId,
          text: `Qual seria o assunto para poder te transferir para o departamento correto?\n\n${MC.departments
            .filter(el => !el.internal)
            .map(el => `* *${el.name}*`)
            .join('\n')}`,
        });
      }
    } catch (e) {
      console.log(`Ocorreu um erro ao processar mensagem [${e.toString()}]`);
    }
  });
})();
```
