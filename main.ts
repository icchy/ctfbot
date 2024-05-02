import { ChannelType, Client, Events, GatewayIntentBits, Partials, PermissionsBitField, REST, Routes, SlashCommandBuilder } from "npm:discord.js@14.14.1";

interface CtfInfo {
  ctfName: string
  roleName: string
  messageId: string
  botChannelId: string
}

const getEnv = (name: string) => {
  const val = Deno.env.get(name)
  if (val === undefined) {
    throw new Error(`no such env: ${name}`)
  }
  return val
}

const kv = await Deno.openKv('kv.sqlite3')
const cacheKey = ['ctfInfo']
const db: CtfInfo[] = (await kv.get(cacheKey)).value || []

const token = getEnv('TOKEN')
const client_id = getEnv('CLIENT_ID')
const guild_id = getEnv('GUILD_ID')

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.Reaction,
    Partials.GuildMember,
  ],
})

const getGuild = (client: Client) => {
  const guild = client.guilds.cache.get(guild_id)

  if (guild === undefined) {
    throw new Error('failed to get guild')
  }

  return guild
}

const registerCommand = async (rest: REST) => {
  const commands = [
    new SlashCommandBuilder().setName('ctf').setDescription('manage ctf channels')
    .addSubcommand(subcommand =>
      subcommand.setName('new').setDescription('prepare new ctf')
      .addStringOption(opt => opt.setName('ctf').setDescription('ctf name').setRequired(true))
      .addStringOption(opt => opt.setName('role').setDescription('role name: [a-z0-9-]+').setRequired(true))
    )
  ].map(command => command.toJSON())

  await rest.put(Routes.applicationGuildCommands(client_id, guild_id), { body: commands })
}

const findRoleByName = (client: Client, name: string) => {
  const role = getGuild(client).roles.cache.find(el => el.name === name)
  return role
}

const getRoleByName = (client: Client, name: string) => {
  const role = findRoleByName(client, name)
  if (role === undefined) {
    throw new Error(`no such role: ${name}`)
  }
  return role
}

client.once(Events.ClientReady, async (client) => {
  // check if the bot is in guild
  try {
    getGuild(client)
    await registerCommand(client.rest)
  } catch (e) {
    console.error(e)
    const flags = [
      PermissionsBitField.Flags.Administrator,
      PermissionsBitField.Flags.ManageRoles,
      PermissionsBitField.Flags.UseApplicationCommands,
    ]
    const permissions = new PermissionsBitField(flags)
    console.log(`invite this bot: https://discord.com/api/oauth2/authorize?client_id=${client_id}&permissions=${permissions.bitfield.toString()}&scope=bot`)
    Deno.exit(0)
  }
})

// handle reaction to rules
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  for (const info of db) {
    if (info.messageId === reaction.message.id) {
      const member = getGuild(reaction.client).members.cache.find(el => el.id === user.id)
      if (member) {
        await member.roles.add(getRoleByName(reaction.client, info.roleName))

        const botChannel = getGuild(reaction.client).channels.cache.find(el => el.id === info.botChannelId && el.type === ChannelType.GuildText)
        if (botChannel && botChannel.isTextBased()) {
          const username = member.nickname ? `${member.nickname} (${member.displayName})` : member.displayName
          await botChannel.send({
            content: `${username} joined`
          })
        }
      }  
    }
  }
})

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  for (const info of db) {
    if (info.messageId === reaction.message.id) {
      const member = reaction.message.guild?.members.cache.find(el => el.id === user.id)
      if (member) {
        await member.roles.remove(getRoleByName(reaction.client, info.roleName))

        const botChannel = getGuild(reaction.client).channels.cache.find(el => el.id === info.botChannelId && el.type === ChannelType.GuildText)
        if (botChannel && botChannel.isTextBased()) {
          const username = member.nickname ? `${member.nickname} (${member.displayName})` : member.displayName
          await botChannel.send({
            content: `${username} left`
          })
        }
      }  
    }
  }
})

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return
  }

  if (interaction.commandName === 'ctf') {
    const subcommand = interaction.options.getSubcommand()

    if (subcommand === 'new') {
      const ctfName = interaction.options.getString('ctf')
      const roleName = interaction.options.getString('role')

      if (interaction.channel === null) {
        return
      }

      if (ctfName === null) {
        throw new Error('invalid ctfName')
      }

      if (roleName === null || /^[0-9a-z-]+$/.exec(roleName) === null) {
        throw new Error('invalid roleName')
      }

      const everyone = await getGuild(interaction.client).roles.everyone
      const role = await getGuild(interaction.client).roles.create({
        name: roleName,
      })

      const categoryCh = await getGuild(interaction.client).channels.create({
        name: ctfName,
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          {
            id: everyone,
            deny: [
              PermissionsBitField.Flags.ViewChannel,
            ]
          },
          {
            id: role,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.ManageChannels,
            ],
          }
        ]
      })

      for (const channelName of ['general', 'random']) {
        await getGuild(interaction.client).channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: categoryCh,
        })
      }

      const botChannel = await getGuild(interaction.client).channels.create({
        name: 'bot',
        type: ChannelType.GuildText,
        parent: categoryCh,
        permissionOverwrites: [
          {
            id: everyone,
            deny: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.SendMessagesInThreads,
            ]
          },
          {
            id: role,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
            ]
          }
        ]
      })

      const message = await interaction.channel.send({
        content: `add reaction here to join ${ctfName}!`
      })

      db.push({
        ctfName,
        roleName,
        messageId: message.id,
        botChannelId: botChannel.id,
      })

      await kv.set(cacheKey, db)

      await interaction.reply({
        content: `successfully prepared category ${ctfName} and role ${roleName}`,
        ephemeral: true,
      })
    }
  }
})

client.login(token)
