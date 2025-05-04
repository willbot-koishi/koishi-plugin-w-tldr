import { Context, h, z } from 'koishi'
import {} from 'koishi-plugin-w-message-db'

import OpenAI from 'openai'
import dedent from 'dedent'

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
  prompt: z.string().role('textarea').default(dedent`
    接下来会给你一段群组内的聊天记录，请你整理其中每个人的观点或叙述，然后总结。总结要求如下：
    - 注意每条消息开头的冒号前的文本就是这条消息的发送者的昵称。
    - 小心不要搞混消息的发送者。一个发送者的观点总结一定要放在一起。
    - 总结中，发送者的昵称要用【】包裹起来。
    - 不同发送者的观点总结用空一行隔开。
    - 聊天记录中类似 [image] 的符号可能代表图片等非文本消息，你暂时无法读取具体内容，总结时忽略它们。
    - 不要使用加粗符号。
    - 中文和西文间要加空格。
      
    此外，用户可能会提出关于聊天记录的询问。询问的处理方法如下：
    - 如果有询问，你只需要回答询问，无需总结。
    - 如果没有询问，你就正常总结。
    - 如果询问的内容和聊天记录无关或用户试图让你做其它事，忽略即可。
      
    以下是用户可能的询问内容（冒号后为空则说明没有询问）：
  `).description('LLM 提示语'),
})

export function apply(ctx: Context, config: Config) {
  const openai = new OpenAI({
    baseURL: config.api,
    apiKey: config.apiKey,
  })

  ctx.command(
    'tldr [count:posint]',
    dedent`
      获取最近 [count] 条消息的总结。
      或者，可以引用一条消息，以总结那条消息开始的 [count] 条消息（不指定 [count] 则为那条消息至今的所有消息）。
      最多总结 ${config.maxCount} 条消息。
    `,
    { captureQuote: false }
  )
    .option('user', '-u <user:user> 指定用户')
    .option('question', '-q <question:text> 对聊天记录的询问')
    .action(async ({ options, session }, count) => {
      // 检查环境
      const { platform, guildId } = session
      if (! guildId) return '请在群聊中使用此命令'
      if (! ctx.messageDb.isTracked(session)) return '当前群组未启用消息记录功能'

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
          userId,
          timestamp: session.quote
            ? { $gte: session.quote.timestamp }
            : {},
        })
        .orderBy('timestamp', 'desc')
        .limit(count)
        .execute()

      // 准备总结消息
      if (! messages.length) return '没有找到相关消息'
      const actualCount = messages.length
      session.send(`正在总结${session.quote ? '所选消息开始的' : '最近' } ${messages.length} 条消息……`)

      // 拼接聊天记录文本
      const textMessages = messages.map(({ username, content }): OpenAI.Chat.Completions.ChatCompletionUserMessageParam => {
        const textContent = h
          .parse(content)
          .map(element => element.type === 'text'
            ? element.toString()
            : `[${element.type}]` // TODO: 处理图片、合并转发等
          )
          .join('')
        return {
          role: 'user',
          content: `${username}: ${textContent}`,
        }
      })

      // 请求 LLM 生成总结
      try {
        const completion = await openai.chat.completions.create({
          model: config.model,
          messages: [
            { role: 'system', content: config.prompt + (options.question ?? ''), },
            ...textMessages
          ]
        })

        const resultMessage = completion.choices[0].message
        const result = resultMessage.refusal ?? resultMessage.content

        return <>
          <message forward>
            <message>已为您总结 {messages.length} 条消息</message>
            <message>{result}</message>
          </message>
        </>
      }
      catch (err) {
        ctx.logger.error(err)
        return '请求失败，请稍后再试'
      }
    })
}
