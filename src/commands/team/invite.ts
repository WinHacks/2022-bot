import {
    ButtonInteraction,
    CacheType,
    CategoryChannel,
    Collection,
    CommandInteraction,
    Guild,
    GuildMember,
    Message,
    MessageActionRow,
    MessageButton,
    MessageComponentInteraction,
    TextBasedChannel,
    TextChannel,
} from "discord.js";
import {Document, PullOperator, PushOperator} from "mongodb";
import {Config} from "../../config";
import {
    FindAndUpdate,
    FindOne,
    teamCollection,
    WithTransaction,
} from "../../helpers/database";
import {
    EmbedToMessage,
    GenericError,
    NotVerifiedResponse,
    ResponseEmbed,
    SafeDeferReply,
    SafeReply,
    SuccessResponse,
} from "../../helpers/responses";
import {InviteType, TeamType} from "../../types";
import {
    AlreadyInTeamResponse,
    BuildTeamPermissions,
    IsUserVerified,
    NotInGuildResponse,
    TeamFullResponse,
} from "./team-shared";
import {Document as MongoDocument} from "mongodb";
import {Timestamp} from "../../helpers/misc";
import {MessageButtonStyles} from "discord.js/typings/enums";
import {hyperlink, TimestampStyles} from "@discordjs/builders";
import {logger} from "../../logger";

// FIXME: Need to investigate error caused by inviting member twice
//        (seems to be caused by multiple sessions on MongoDB)

export const InviteToTeam = async (
    intr: CommandInteraction<CacheType>,
    team: TeamType
): Promise<any> => {
    if (!intr.inGuild()) {
        return SafeReply(intr, NotInGuildResponse());
    } else if (!(await IsUserVerified(intr.user.id))) {
        return SafeReply(intr, NotVerifiedResponse(true));
    }

    if (team.members.length >= Config.teams.max_team_size) {
        return SafeReply(intr, TeamFullResponse());
    }

    const invitee = intr.options.getUser("user", true);

    await SafeDeferReply(intr);

    if (!(await IsUserVerified(invitee.id))) {
        return SafeReply(
            intr,
            EmbedToMessage(
                ResponseEmbed()
                    .setTitle(":x: User Not Verified")
                    .setDescription(
                        "You can only invite verified users to your team. Ask them to verify first with `/verify`."
                    )
            )
        );
    } else if (intr.user.id === invitee.id && !Config.dev_mode) {
        return SafeReply(
            intr,
            EmbedToMessage(
                ResponseEmbed()
                    .setTitle(":confused: You're Already In Your Team")
                    .setDescription(
                        "You tried to invite yourself to your own team. Sadly, cloning hasn't been invented yet."
                    )
            )
        );
    } else if (team.members.includes(invitee.id)) {
        return SafeReply(
            intr,
            EmbedToMessage(
                ResponseEmbed()
                    .setTitle(":confused: Member Already Joined")
                    .setDescription("That user is already a member of your team.")
            )
        );
    } else if (team.invites.findIndex((inv) => inv.invitee === invitee.id) !== -1) {
        return SafeReply(
            intr,
            EmbedToMessage(
                ResponseEmbed()
                    .setTitle(":confused: Member Already Invited")
                    .setDescription(
                        "You already invited that user. Please wait a few minutes before trying again."
                    )
            )
        );
    }

    const inviteDuration = Config.teams.invite_duration * 60_000;
    const invite: InviteType = {
        teamName: team.name,
        invitee: invitee.id,
        inviteID: `${Date.now()}`,
    };
    let message: Message<boolean>;
    const inviteError = await WithTransaction(async (session) => {
        const inviteAdd = await FindAndUpdate<TeamType>(
            teamCollection,
            team,
            {$push: {invites: invite} as unknown as PushOperator<MongoDocument>},
            {session}
        );
        if (!inviteAdd) {
            return "Failed to add invite";
        }

        const buttonRow = new MessageActionRow().setComponents(
            new MessageButton()
                .setStyle(MessageButtonStyles.SECONDARY)
                .setCustomId(`decline#${invite.inviteID}`)
                .setLabel("Decline"),
            new MessageButton()
                .setStyle(MessageButtonStyles.PRIMARY)
                .setCustomId(`accept#${invite.inviteID}`)
                .setLabel("Accept")
        );
        const inviteMsg = ResponseEmbed()
            .setTitle(":partying_face: You've Been Invited")
            .setDescription(
                [
                    `You've been invited to join Team ${team.name}`,
                    `for ${Config.bot_info.event_name} by`,
                    `${(intr.member! as GuildMember).displayName}.`,
                    `This invite expires ${Timestamp(
                        Date.now() + inviteDuration,
                        TimestampStyles.LongDateTime
                    )}.`,
                ].join(" ")
            );

        try {
            message = await invitee.send({
                embeds: [inviteMsg],
                components: [buttonRow],
            });
        } catch (err) {
            return `Failed to invite user: ${err}`;
        }

        return "";
    });

    // message send failed or something
    if (inviteError) {
        logger.debug(inviteError);
        return SafeReply(intr, {
            embeds: [
                ResponseEmbed()
                    .setTitle(":x: Can't DM User")
                    .setDescription(
                        `It seems ${invitee} doesn't allow DMs from this server. Please ask them to ${hyperlink(
                            "enable direct messages",
                            "https://support.discord.com/hc/en-us/articles/217916488-Blocking-Privacy-Settings-"
                        )} and then re-invite them.`
                    ),
            ],
        });
    }

    const collector = message!.createMessageComponentCollector({
        componentType: "BUTTON", // only accept button events
        max: 1, // makes the collector terminate after the first button is clicked.
        time: inviteDuration, // invite_duration from minutes to ms
    });

    collector.on("end", async (col, rsn) => {
        await HandleCollectorTimeout(col, rsn, invite, message);
    });
    collector.on("collect", async (buttonIntr) => {
        if (buttonIntr.customId.startsWith("accept")) {
            const error = await HandleOfferAccept(buttonIntr, intr.guild!, invite);
            if (!error) {
                SafeReply(
                    buttonIntr,
                    SuccessResponse(
                        `You joined ${invite.teamName} ${Timestamp(Date.now())}.`
                    )
                );
            } else if (error === "Already in team") {
                SafeReply(buttonIntr, AlreadyInTeamResponse());
            } else {
                SafeReply(buttonIntr, GenericError());
            }
        } else {
            const error = await HandleOfferDecline(buttonIntr, invite);
            if (!error) {
                SafeReply(buttonIntr, {
                    embeds: [
                        ResponseEmbed()
                            .setTitle("Invite Declined")
                            .setDescription(
                                `You declined to join ${invite.teamName} ${Timestamp(
                                    Date.now()
                                )}.`
                            ),
                    ],
                });
            } else {
                SafeReply(buttonIntr, GenericError());
            }
        }
    });

    const teamText = intr.guild!.channels.cache.get(team.textChannel) as TextBasedChannel;
    const invitedMember = intr.guild!.members.cache.get(invitee.id)!;
    const invitedEmbed = ResponseEmbed()
        .setTitle(":white_check_mark: Invite Sent")
        .setDescription(
            `${invitedMember.displayName} has been invited. The invite will expire in ${Config.teams.invite_duration} minutes.`
        );

    try {
        await teamText.send({embeds: [invitedEmbed]});
    } catch (err) {
        logger.warn(`Failed to send channel creation message to ${teamText}: ${err}`);
    }
    return SafeReply(intr, {embeds: [invitedEmbed], ephemeral: true});
};

// TODO: clean up the message handling
const HandleOfferAccept = async (
    intr: MessageComponentInteraction<CacheType>,
    guild: Guild,
    invite: InviteType
) => {
    const [team, inTeam] = await Promise.all([
        FindOne<TeamType>(teamCollection, {invites: invite}),
        FindOne<TeamType>(teamCollection, {members: intr.user.id}),
    ]);

    if (inTeam) {
        return "Already in team";
    } else if (!team) {
        return "Team not found";
    } else if (team.members.includes(intr.user.id) && !Config.dev_mode) {
        return "Members cannot join teams they're already a part of";
    } else if (team.members.length >= Config.teams.max_team_size) {
        return "Team is full";
    }

    team.members.push(intr.user.id);

    const teamText = guild.channels.cache.get(team.textChannel) as CategoryChannel;
    const teamVoice = guild.channels.cache.get(team.voiceChannel) as CategoryChannel;

    if (!teamText || !teamVoice) {
        return "Couldn't find team channel(s)";
    }

    // this is a valid conversion, DiscordJS is STUPID
    (teamText as unknown as TextChannel).send(
        SuccessResponse(`${intr.user} joined the team!`)
    );

    const oldTextPerms = teamText.permissionOverwrites.valueOf();
    const oldVoicePerms = teamVoice.permissionOverwrites.valueOf();

    const joinError = await WithTransaction(
        async (session) => {
            const newPerms = BuildTeamPermissions(guild, team.members);
            await Promise.allSettled([
                teamText.permissionOverwrites.set(newPerms),
                teamVoice.permissionOverwrites.set(newPerms),
            ]);

            const update = await FindAndUpdate(
                teamCollection,
                {invites: invite},
                {
                    $push: {members: invite.invitee},
                    $pull: {invites: invite},
                } as unknown as PushOperator<MongoDocument>,
                {session}
            );
            if (!update) {
                return "Failed to update team";
            }

            const msg = intr.message as Message<boolean>;
            await msg.edit({components: []});

            return "";
        },
        async (err) => {
            logger.error(`Failed to join ${invite.teamName}: ${err}`);
            await Promise.allSettled([
                teamText.permissionOverwrites.set(oldTextPerms),
                teamVoice.permissionOverwrites.set(oldVoicePerms),
            ]);
        }
    );

    return joinError;
};

const HandleOfferDecline = async (
    intr: MessageComponentInteraction<CacheType>,
    invite: InviteType
) => {
    return await WithTransaction(async (session) => {
        const updateError = await FindAndUpdate(
            teamCollection,
            {invites: invite},
            {$pull: {invites: invite} as unknown as PullOperator<Document>},
            {session}
        );
        if (!updateError) {
            return "Failed to remove invite from team";
        }

        const msg = intr.message as Message<boolean>;
        try {
            msg.edit({components: []});
        } catch (_) {
            return "Failed replace invite with declined status";
        }

        return "";
    });
};

const HandleCollectorTimeout = async (
    _: Collection<string, ButtonInteraction<CacheType>>,
    reason: string,
    invite: InviteType,
    message: Message<boolean>
) => {
    if (reason !== "time") {
        return;
    }

    try {
        await FindAndUpdate(
            teamCollection,
            {invites: invite},
            {$pull: {invites: invite} as unknown as PullOperator<Document>}
        );
    } catch (err) {
        logger.error(`Failed to remove invite on expiration: ${err}`);
    }

    message.edit({
        components: [],
        embeds: [
            ResponseEmbed()
                .setTitle(":confused: Invite Expired")
                .setDescription(
                    `This invite to join ${invite.teamName} expired ${Timestamp(
                        Date.now()
                    )}. You'll need to ask for a new invite.`
                ),
        ],
    });
};
