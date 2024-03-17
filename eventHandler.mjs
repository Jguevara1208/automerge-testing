import { EventEmitter } from 'events';
import { getInitialTextForDoc } from './SharedDocumentHandler.mjs';
// eslint-disable-next-line import/no-extraneous-dependencies
import { next as A } from '@automerge/automerge';

export const eventEmitterMap = {};
export const userSyncState = {};

export async function addEventEmitter(type, identifier, user, queryKey) {
  // Directly access or initialize the typeMap
  const typeMap = eventEmitterMap[type] || {};
  // Ensure an object exists for the identifier
  if (!typeMap[identifier]) {
    typeMap[identifier] = {
      eventEmitter: new EventEmitter(),
      users: new Set(), // Use a Set for unique user IDs
    };
  }

  // Add the user to the set
  typeMap[identifier].users.add(user);

  // If it's a shared doc event, add a document
  if (type === 'shared-doc') {
    const initialText = await getInitialTextForDoc(identifier, queryKey);
    if (!typeMap[identifier].doc) {
      typeMap[identifier].doc = undefined;
      // Generate and store the server doc
      const newDoc = A.from({ text: initialText });
      typeMap[identifier].doc = newDoc;
    }
    if (!userSyncState[`${identifier}-${user}`]) {
      userSyncState[`${identifier}-${user}`] = A.initSyncState();
    }
  }

  // Update the eventEmitterMap with the new or updated typeMap
  eventEmitterMap[type] = typeMap;
}

export function getUserSyncState(identifier, user) {
  return userSyncState[`${identifier}-${user}`];
}

export function getSharedDocument(identifier) {
  return eventEmitterMap['shared-doc']?.[identifier] ? eventEmitterMap['shared-doc'][identifier].doc : undefined;
}

export function getEventObject(type, identifier) {
  const typeMap = eventEmitterMap[type];
  return typeMap[identifier] ? typeMap[identifier] : undefined;
}

export function getEventEmitter(type, identifier) {
  const typeMap = eventEmitterMap[type];
  return typeMap ? typeMap[identifier]?.eventEmitter : undefined;
}

function evictEventEmitter(type, identifier) {
  const typeMap = eventEmitterMap[type];
  if (typeMap && typeMap[identifier]) {
    // Delete the identifier entry
    delete typeMap[identifier];

    // If no identifiers are left for a type, clean up the type map
    if (Object.keys(typeMap).length === 0) {
      delete eventEmitterMap[type];
    }
  }
}

export function removeEventUser(type, identifier, user) {
  const typeMap = eventEmitterMap[type];
  if (typeMap && typeMap[identifier]) {
    // Remove the user from the set
    typeMap[identifier].users.delete(user);

    // If no users are left, evict the event emitter
    if (typeMap[identifier].users.size === 0) {
      evictEventEmitter(type, identifier);
    }
  }
}

export function broadcastServerRestart() {
  for (const typeMap of Object.values(eventEmitterMap)) {
    for (const details of Object.values(typeMap)) {
      const emitter = details.eventEmitter;
      emitter.emit('server-restarting');
    }
  }
}
