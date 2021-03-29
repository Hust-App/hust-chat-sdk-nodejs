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

## Exemplo de uso

```typescript
import Macrochat from './src/Macrotchat';

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
