import { AbstractTool } from './AbstractTool.js';
import ws from 'ws';
// VoiceTool.js
export class VoiceTool extends AbstractTool {
  constructor() {
    super();
    this.name = 'voiceTool';
    this.description = '这是一个实现你发送语音功能的工具，平常正常对话时、当你想发送语音时，调用此工具（尽可能做到主动调用发送语音）。';
    this.parameters = {
      type: "object",
      properties: {
        text: {
          type: 'string',
          description: '你想发送的语音文字(注意不要包含颜文字等内容，只要纯文字，颜文字等内容会使语音转文字出问题，如果有英文单词或字母尝试用中文谐音代替)'
        },

      },
      required: ['text']
    };

  }

  async func(opts, e) {
    const { text } = opts;

    const groupId = e.group_id;

    // try {
    //   const resData = await Bot.sendApi('send_group_ai_record', {
    //     "group_id": groupId,
    //     "character": "lucy-voice-female1",
    //     "text": text
    //   });

    //   if (resData.status == 'ok') {
    //     return `发送语音内容(${text})成功，你已经发送语音了，所以不需要强调你已经发送语音，继续说之后的事情`;
    //   } else {
    //     return `发送语音失败`;
    //   }

    // } catch (error) {
    //   console.error(`发送语音失败:`, error);
    //   return `发送语音失败: ${error.message}`;
    // }


    try {
      let file_url
      let voice
      const file = 'https://www.modelscope.cn/api/v1/studio/Xzkong/AI-jiaran/gradio/file='
      const cookie = 'session=MTc1MjY0NzczOXxEWDhFQVFMX2dBQUJFQUVRQUFEX3hmLUFBQVlHYzNSeWFXNW5EQVFBQW1sa0EybHVkQVFFQVA0S0ZnWnpkSEpwYm1jTUNnQUlkWE5sY201aGJXVUdjM1J5YVc1bkRCRUFELVdHc09XSGllV0lzT21BbXVtQWp3WnpkSEpwYm1jTUJnQUVjbTlzWlFOcGJuUUVBZ0FDQm5OMGNtbHVad3dJQUFaemRHRjBkWE1EYVc1MEJBSUFBZ1p6ZEhKcGJtY01Cd0FGYkdWMlpXd0djM1J5YVc1bkRBZ0FCbFJwWlhJZ01RWnpkSEpwYm1jTUVRQVBjMlZ6YzJsdmJsOTJaWEp6YVc5dUJXbHVkRFkwQkFvQS1EQ2xUNnFCMzJHb3y5H0YUVdJyT50SZGYpSgHz20sqNKQPWKoeTmOYl7AOvA=='
      const other_params = [0.2, 0.6, 0.8, 1];
      const data = {
        "data": [text, 'jiaran', ...other_params],
        "fn_index": 0,
        "session_hash": Math.random().toString(36).substring(2, 13)
      };
      const response = await fetch('https://www.modelscope.cn/api/v1/studio/Xzkong/AI-jiaran/gradio/run/predict', {
        method: 'POST',
        body: JSON.stringify(data),
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookie
        }
      });
      const result = await response.json();
      logger.error(result, 789)
      if (result && result.data[0] == 'Success') {
        file_url = result.data[1].name;
      }
      voice = file_url ? `${file}${file_url}` : null;
      if (voice) {
        await e.reply(segment.record(voice));
        return `发送语音内容(${text})成功，你已经发送语音了，所以不需要强调你已经发送语音，继续说之后的事情`;
      } else {
        return `发送语音失败`;
      }

    } catch (error) {
      return `发送语音失败: ${error.message}`;
    }


    const hugg = () => {
      return new Promise((resolve, reject) => {
        let hash = Math.random().toString(36).substring(2, 12);
        let ws_client = new ws('wss://songdaooi-taffy-bert-vits2.hf.space/queue/join?__theme=system');
        let voice = 'https://songdaooi-taffy-bert-vits2.hf.space/--replicas/2iodv/file='
        const data = {
          "data": [
            text,
            "taffy",
            0.2,
            0.6,
            0.8,
            1
          ],
          "fn_index": 0,
          "session_hash": Math.random().toString(36).substring(2, 13)
        };

        ws_client.on("open", () => {
        });

        ws_client.on("message", async event => {
          event = JSON.parse(event);
          switch (event.msg) {
            case "send_hash":
              ws_client.send(JSON.stringify({
                session_hash: hash,
                fn_index: 0,
              }));
              break;
            case "estimation":
              {
                break;
              };
            case "send_data":
              ws_client.send(JSON.stringify({
                "data": data.data,
                "fn_index": 0,
                "session_hash": hash,
              }));
              break;
            case "process_starts":
              {
                break;
              }
            case "process_completed":
              ws_client.close();
              if (event.output.data[0] == 'Success') {
                // let file_url = event.output.data[1];
                // const base64 = file_url.split(",")[1];
                // await e.reply(segment.record(`data:audio/wav;base64,${base64}`));

                await e.reply(segment.record(`${voice}${event.output.data[1].name}`));
                resolve(`发送语音内容(${text})成功，你已经发送语音了，所以不需要强调你已经发送语音，继续说之后的事情`)

              } else {
                reject(`发送语音失败`)
              }
              break;
            case "process_failed":
              ws_client.close();
              reject(`发送语音失败`)
              break;
          }
        });

        ws_client.on("error", error => {
          ws_client.close();
          reject(`发送语音失败`)
        });

        ws_client.on("close", () => {

        });
      })
    }

    const result = await hugg()
    return result
  }
}