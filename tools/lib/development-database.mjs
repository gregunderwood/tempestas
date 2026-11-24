export const DEVELOPMENT_DATABASE_CONTAINER = 'tempestas-db';
export const DEVELOPMENT_DATABASE_USER = 'tempestas';

const SHARED_DATABASE_NAME = 'tempestas';
const DEVELOPMENT_DATABASE_PATTERN =
  /^tempestas_(dev|pr_[0-9]+_(before|after))(_[a-z0-9]+)*$/;
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
const DEVELOPMENT_COMPOSE_SERVICE = 'db';

export const DEVELOPMENT_DATABASE_RULE = `<database> must be a dev or screenshot database: tempestas_dev, tempestas_dev_<suffix> or
tempestas_pr_<n>_before|after, or ${SHARED_DATABASE_NAME} itself when ${DEVELOPMENT_DATABASE_CONTAINER} is the dev container
started by docker compose. Production shares that name but starts its container with docker run,
so there ${SHARED_DATABASE_NAME} is refused.`;

export function explainDatabaseRefusal(databaseName, containerLabels) {
  if (databaseName === SHARED_DATABASE_NAME) {
    if (isDevelopmentComposeContainer(containerLabels)) return null;
    return `refusing ${databaseName}: ${DEVELOPMENT_DATABASE_CONTAINER} was not started by this repo's docker compose, so it may be production.`;
  }
  if (DEVELOPMENT_DATABASE_PATTERN.test(databaseName)) return null;
  return `refusing ${databaseName}: not a dev or screenshot database name.`;
}

function isDevelopmentComposeContainer(containerLabels) {
  return (
    containerLabels?.[COMPOSE_SERVICE_LABEL] === DEVELOPMENT_COMPOSE_SERVICE
  );
}
