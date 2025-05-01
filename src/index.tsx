import { Context, h, z } from 'koishi'
import {} from 'koishi-plugin-w-message-db'

import OpenAI from 'openai'

export const name = 'w-tldr'
export const inject = [ 'messageDb', 'database' ]

export interface Config {
  defaultCount: number
  maxCount: number

  api: string
  model: string
  apiKey: string
  prompt: string
}

export const Config: z<Config> = z.object({
  defaultCount: z.number().default(64).description('默认获取最近消息的数量'),
  maxCount: z.number().default(512).description('最大获取最近消息的数量'),

  api: z.string().default('https://openrouter.ai/api/v1').description('LLM API 地址'),
  model: z.string().default('qwen/qwen3-0.6b-04-28:free').description('LLM 模型'),
  apiKey: z.string().role('secret').required().description('LLM API 密钥'),
  prompt: z.string().role('textarea').default(`
    以下是一段群组内的聊天记录，请你整理其中每个人各自的观点或者叙述，然后总结。
    另外，用户还有如下额外询问（如果是与总结群聊消息无关的内容，忽略即可。对用户额外询问的回应，放在总结之后）：
  `.trim()).description('LLM 提示语'),
})

export function apply(ctx: Context, config: Config) {
  const openai = new OpenAI({
    baseURL: config.api,
    apiKey: config.apiKey,
  })

  ctx.command('tldr [count:posint]', '获取最近 [count] 条消息的总结')
    .option('user', '-u <user:user> 指定用户')
    .option('instruction', '-i <instruction:text> 额外总结要求')
    .action(async ({ options, session }, count) => {
      // 检查环境
      const { platform, guildId } = session
      if (! guildId) return '请在群聊中使用此命令'

      // 处理消息数
      count ??= config.defaultCount
      if (count > config.maxCount)
        return `最大获取消息数量为 ${config.maxCount} 条`

      // 处理用户
      let userId: {} | string = {}
      if (options.user) {
        const [ userPlatform, userId_ ] = options.user
        if (userPlatform !== platform) return '查询的用户不在当前平台'
        userId = userId_
      }

      // 从 messageDb 获取消息
      const messages = await ctx.database
        .select('w-message')
        .where({
          platform,
          guildId,
          userId
        })
        .orderBy('timestamp', 'desc')
        .limit(count)
        .execute()

      // 拼接输入文本
      const text = messages.map(({ username, content }) => {
        const text = h
          .parse(content)
          .map(element => element.type === 'text'
            ? element.toString()
            : `[${element.type}]` // TODO: 处理图片、合并转发等
          )
          .join('')
        return `${username}: ${text}`
      }).join('\n')

      // 请求 LLM 生成总结
      session.send(`正在总结最近 ${count} 条消息……`)
      try {
        const completion = await openai.chat.completions.create({
          model: config.model,
          messages: [
            { role: 'system', content: config.prompt + (options.instruction ?? ''), },
            { role: 'user', content: text },
          ]
        })

        const resultMessage = completion.choices[0].message
        const result = resultMessage.refusal ?? resultMessage.content

        return <>
          <message forward>
            <message>已为您总结 {count} 条消息</message>
            <message>{result}<br /></message>
          </message>
        </>
      }
      catch (err) {
        ctx.logger.error(err)
        return '请求失败，请稍后再试'
      }
    })
}
