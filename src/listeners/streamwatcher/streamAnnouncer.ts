import { DiscordClient } from '../chat/discord/discordBot.js';
import { AnnounceChannel } from '../../models/announceChannel.js';
import { TwitchApi, TwitchStream } from '../../clients/twitchApi.js';
import { timeoutPromise } from '../../utils.js';
import { getLogger } from '../../logger.js';
const logger = getLogger('StreamAnnouncer');

const ANNOUNCE_CHECK_PERIOD_MS = 15000;
const CHECK_TIMEOUT_MS = 60000;
let mutex = false;
let interval: any = undefined;
const startTime = new Date();
interface streamCache {
  [streamId: string]: any;
}
const activeStreams: streamCache = {};
const activeSpeedrunStreams: streamCache = {};

const mmbnGameTwitchIds = [
  '7542', // Mega Man Battle Network
  '24465', // Rockman EXE Operate Shooting Star
  '4682', // Mega Man Battle Network 2
  '12105', // Mega Man Battle Network 3
  '544992838', // Mega Man Battle Network 3 Blue & White
  '1388250717', // Mega Man Battle Network 3 Blue
  '1550736308', // Mega Man Battle Network 3 White
  '3108', // Mega Man Battle Network 4
  '115596254', // Mega Man Battle Network 4 Red Sun
  '581486297', // Mega Man Battle Network 4 Blue Moon
  '1206553196', // Mega Man Battle Network 4 Red Sun & Blue Moon
  '10763', // Mega Man Battle Network 4.5: Real Operation
  '11522', // Mega Man Battle Network 5
  '324568485', // Mega Man Battle Network 5: Team Colonel
  '1465689050', // Mega Man Battle Network 5: Team Colonel & Protoman
  '1984284718', // Mega Man Battle Network 5: Team Protoman
  '9009', // Mega Man Battle Network 5: Double Team
  '2020525577', // Mega Man Battle Network 5: Double Team DS
  '7325', // Mega Man Battle Network 6
  '740052011', // Mega Man Battle Network 6: Cybeast Falzar
  '1565051033', // Mega Man Battle Network 6: Cybeast Gregar
  '17587', // Mega Man Battle Chip Challenge
  '861766602', // RockMan EXE N1 Battle
  '5831', // Mega Man Network Transmission
  '22528', // Rockman EXE WS
  '416185', // Mega Man Battle Network Chrono X
  '457859481', // Rockman EXE Battle Chip Stadium
  '113768894', // Rockman EXE The Medal Operation
  '1350', // Mega Man Star Force: Leo
  '1155000360', // Mega Man Star Force: Dragon
  '1808999901', // Mega Man Star Force: Pegasus
  '18770', // Mega Man Star Force 2: Zerker x Ninja
  '210749169', // Mega Man Star Force 2: Zerker x Saurian
  '19495', // Mega Man Star Force 3: Red Joker
  '71553216', // Mega Man Star Force 3: Black Ace
  '172137957', // Ryūsei no Rockman: Denpa Henkan! On Air!
  '556915707', // Rockman EXE Phantom of Network
  '2126164907', // Rockman EXE Legend of Network
  '1490943277', // Mega Man Battle Network 5: Patch Card - Dominerd
  '425135421',  // MEGA MAN STAR FORCE: Legacy Collection
];

const speedrunTwitchTags = new Set(['speedrun', 'speedruns', 'rta']);

export async function getActiveStreams() {
  const gameStreams = TwitchApi.getStreamsOfGames(mmbnGameTwitchIds);
  const twitchChannelIds = (await AnnounceChannel.getStreamDetectionChannels()).map((chan) => chan.channel);
  // Fetch all streams for individual channels and games
  const streams = (await Promise.all([TwitchApi.getStreamsOfUsers(twitchChannelIds), gameStreams])).flat();
  // Streams array can have duplicates; only return unique streams
  const existingIds = new Set<string>();
  return streams.filter((stream) => {
    const unique = !existingIds.has(stream.id);
    existingIds.add(stream.id);
    return unique;
  });
}

// Not intended to be called directly outside of this module, only exported for testing
export async function checkAndAnnounceStreams() {
  if (mutex) {
    logger.info('Skipping stream announce check because another is still running');
    return;
  }
  mutex = true;
  try {
    await timeoutPromise(
      (async () => {
        logger.debug('Starting check for streams');
        const streams = await getActiveStreams();
        if (streams.length > 0) {
          // Clean the active stream caches by counting misses and removing streams that have been offline for some time
          cleanStreamCache(activeStreams, streams);
          cleanStreamCache(activeSpeedrunStreams, streams);
          const announceChannels = await AnnounceChannel.getLiveAnnounceChannels();
          const speedrunAnnounceChannels = await AnnounceChannel.getSpeedrunLiveAnnounceChannels();
          const speedrunStreams = new Set<string>();
          // If we need to announce speedruns, find stream tags and filter out streams with speedrun tag(s)
          if (speedrunAnnounceChannels.length > 0) {
            streams.forEach((stream) => {
              if (stream.tags.some((tag) => speedrunTwitchTags.has(tag.toLowerCase()))) {
                speedrunStreams.add(stream.id);
              }
            });
          }
          for (const stream of streams) {
            // All streams
            await checkAndAnnounceStream(activeStreams, stream, announceChannels);
            // Speedrun tagged streams
            if (speedrunStreams.has(stream.id)) await checkAndAnnounceStream(activeSpeedrunStreams, stream, speedrunAnnounceChannels);
          }
        }
        logger.debug('Stream discovery/announce complete');
      })(),
      CHECK_TIMEOUT_MS,
      new Error('Check timed out'),
    );
  } catch (e) {
    logger.error('Unexpected error fetching/announcing streams:', e);
  }
  mutex = false;
}

function cleanStreamCache(cache: streamCache, streams: TwitchStream[]) {
  Object.keys(cache).forEach((streamId) => {
    // Add miss-count to already announced stream if it didn't appear in the twitch api requests
    if (!streams.some((stream) => stream.id === streamId)) cache[streamId].misses += 1;
    // Clear out streams from cache that have been excluded from the API for the last few calls (are offline/completed)
    // Only clear after so many misses so we can keep track of previously announced streams for some time to de-dupe restarted streams from announcements
    if (cache[streamId].misses > 120) delete cache[streamId];
  });
}

async function checkAndAnnounceStream(cache: streamCache, stream: TwitchStream, channels: AnnounceChannel[]) {
  if (
    cache[stream.id] === undefined &&
    startTime < stream.start &&
    !Object.values(cache).some((activeStream) => stream.username === activeStream.username && stream.title === activeStream.title && stream.game === activeStream.game)
  ) {
    /*
    Only announce if:
    Stream was not previously active (has not been announced already)
    Bot start time is before stream start time (so we don't announce duplicates if the bot restarts)
    Another announced (active) stream does not exist which has identical user/title/game (same stream restarted with new id)
    */
    const announceMessage = `${stream.displayName.replace('_', '\\_')} is live playing: ${stream.game}\n<${stream.url}>\n\`\`\`${stream.title}\`\`\``;
    await Promise.all(channels.map((chan) => DiscordClient.sendMessage(chan.channel, announceMessage)));
  }
  cache[stream.id] = { ...stream, misses: 0 };
}

export function scheduleStreamAnnouncer() {
  interval = setInterval(checkAndAnnounceStreams, ANNOUNCE_CHECK_PERIOD_MS);
  logger.info(`Now scheduled to check for streams every ${ANNOUNCE_CHECK_PERIOD_MS / 1000} seconds`);
}

export function unscheduleStreamAnnouncer() {
  if (interval) clearInterval(interval);
}
