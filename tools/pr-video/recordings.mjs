// Turns a stack run's videos into the player's videos.json, and that into the PR comment.
// Usage: node tools/pr-video/recordings.mjs player <videos folder> <player folder> <pr> <commit>
//        node tools/pr-video/recordings.mjs comment <player folder> <image url base> <download url base> <marker>

import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

const VIDEO_SUFFIX = '.mp4';
const TEST_STARTS_SUFFIX = '.test-starts.json';
const GIF_WIDTH = 800;
const PLAYER_LINK_PLACEHOLDER = '<!-- player-link -->';

function readTestStarts(videosFolder, spec) {
  const startsFile = join(videosFolder, `${spec}${TEST_STARTS_SUFFIX}`);
  return existsSync(startsFile)
    ? JSON.parse(readFileSync(startsFile, 'utf8'))
    : [];
}

function writePlayerData(videosFolder, playerFolder, pullRequest, commit) {
  const videos = readdirSync(videosFolder)
    .filter((name) => name.endsWith(VIDEO_SUFFIX))
    .sort()
    .map((name) => {
      const spec = basename(name, VIDEO_SUFFIX);
      copyFileSync(join(videosFolder, name), join(playerFolder, name));
      return { spec, file: name, steps: readTestStarts(videosFolder, spec) };
    });
  const recordings = { pullRequest, commit, videos };
  writeFileSync(
    join(playerFolder, 'videos.json'),
    `${JSON.stringify(recordings, null, 2)}\n`,
  );
}

function describeRecording(video, imageUrlBase, downloadUrlBase) {
  const gif = video.file.replace(VIDEO_SUFFIX, '.gif');
  return [
    `### \`${video.spec}\``,
    '',
    ...video.steps.map((step, index) => `${index + 1}. ${step.title}`),
    '',
    `<img src="${imageUrlBase}/${gif}?raw=true" width="${GIF_WIDTH}">`,
    '',
    PLAYER_LINK_PLACEHOLDER,
    '',
    `**[Download the mp4](${downloadUrlBase}/${video.file})** to pause, seek or change the speed in any video player.`,
  ].join('\n');
}

function writeComment(playerFolder, imageUrlBase, downloadUrlBase, marker) {
  const recordings = JSON.parse(
    readFileSync(join(playerFolder, 'videos.json'), 'utf8'),
  );
  const sections = recordings.videos.map((video) =>
    describeRecording(video, imageUrlBase, downloadUrlBase),
  );
  return [
    marker,
    '## Video',
    '',
    `Recorded at \`${recordings.commit}\` by \`tools/pr-video.sh\`, which runs the Cypress specs in \`apps/web-e2e/src/stack\` on a real server with the fake driver. GitHub plays the GIF inline. The player and the mp4 can be paused, sought and slowed down.`,
    '',
    ...sections.flatMap((section) => [section, '']),
  ].join('\n');
}

const [command, ...options] = process.argv.slice(2);
if (command === 'player' && options.length === 4) {
  writePlayerData(...options);
} else if (command === 'comment' && options.length === 4) {
  process.stdout.write(writeComment(...options));
} else {
  console.error(
    'Usage: recordings.mjs player <videos> <player> <pr> <commit> | comment <player> <image base> <download base> <marker>',
  );
  process.exit(2);
}
