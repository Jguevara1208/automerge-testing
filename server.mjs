// Automerge updates
if (urlObject.pathname === '/automerge-updates') {
  // Check origin against the allowed list
  if (!ALLOWED_REQUEST_ORIGIN_SET.has(request.headers.origin) && !request.headers.origin?.match(ALLOWED_REQUEST_ORIGIN_WILDCARD)) {
    throw new ServerError.ForbiddenError({
      reason: `Provided origin "${request.headers.origin}" is not an allowed API request origin.`,
      originalError: Error('OriginNotAllowedError'), // since 403 is  overused
    });
  }
  response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); // Explicitly allow these headers
  if (request.method === 'OPTIONS') {
    // Pre-flight request. Respond with OK status.
    response.writeHead(200);
    response.end();
    return;
  }
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');

  let body = '';

  // Collect data chunks
  request.on('data', (chunk) => {
    body += chunk.toString(); // Convert Buffer to string and append
  });

  // Once all chunks are received
  request.on('end', async () => {
    try {
      // Only proceed with parsing if the body is not empty
      if (body) {
        const { syncMessageBase64, identifier, queryKey, user } = JSON.parse(body);
        const eventObject = getEventObject('shared-doc', identifier);
        let { doc } = eventObject;

        let syncState = getUserSyncState(identifier, user);
        const recievedMessage = Uint8Array.from(Buffer.from(syncMessageBase64, 'base64'));
        let newMessage;
        const oldHeads = A.getHeads(doc);
        [doc, syncState, newMessage] = A.receiveSyncMessage(doc, syncState, recievedMessage);
        const newHeads = A.getHeads(doc);
        if (newMessage) {
          const buffer = Buffer.from(newMessage);
          const syncMessageToBroadcast = buffer.toString('base64');
          eventObject.eventEmitter.emit('update', {
            syncMessage: syncMessageToBroadcast,
            user,
          });
        }

        const [newSyncState, syncMessage] = A.generateSyncMessage(doc, syncState);
        syncState = newSyncState;
        const buffer = Buffer.from(syncMessage);
        const syncMessageToBroadcast = buffer.toString('base64');

        // // Broadcast the sync message to all clients
        eventObject.eventEmitter.emit('update', {
          syncMessage: syncMessageToBroadcast,
          user,
        });

        if (oldHeads[0] !== newHeads[0]) { // change this to take into account they are an array of heads
          eventObject.users.forEach((uuid) => {
            if (uuid !== user) {
              let userSyncState = getUserSyncState(identifier, uuid);
              const [newUserSyncState, newUserSyncMessage] = A.generateSyncMessage(doc, userSyncState);
              userSyncState = newUserSyncState;
              const userBuffer = Buffer.from(newUserSyncMessage);
              const userSyncMessageToBroadcast = userBuffer.toString('base64');
              eventObject.eventEmitter.emit('update', { user: uuid, syncMessage: userSyncMessageToBroadcast });
            }
          });
        }

        eventObject.doc = doc;

        // const serializedData = JSON.stringify(newDoc.text);
        // const stringData = JSON.parse(serializedData);
        // const result = await updateDocumentText(identifier, queryKey, stringData);
      } else {
        // Handle empty body
        response.writeHead(400);
        response.end('Empty request body');
      }
    } catch (error) {
      console.error('Error processing request body:', error);
      response.writeHead(400);
      response.end(`Bad request: ${error.message}`);
    }
  });
  return;
}

// SSE endpoint
if (urlObject.pathname === '/events') {
  const eventType = urlObject.searchParams.get('type');
  const eventIdentifier = urlObject.searchParams.get('identifier');
  const eventUser = urlObject.searchParams.get('user');
  const eventEvict = urlObject.searchParams.get('evict');
  const queryKey = urlObject.searchParams.get('queryKey');

  if (eventEvict) {
    removeEventUser(eventType, eventIdentifier, eventUser);
    return;
  }

  // Set headers for SSE
  // Check origin against the allowed list
  if (!ALLOWED_REQUEST_ORIGIN_SET.has(request.headers.origin) && !request.headers.origin?.match(ALLOWED_REQUEST_ORIGIN_WILDCARD)) {
    throw new ServerError.ForbiddenError({
      reason: `Provided origin "${request.headers.origin}" is not an allowed API request origin.`,
      originalError: Error('OriginNotAllowedError'), // since 403 is  overused
    });
  }
  response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');

  await addEventEmitter(eventType, eventIdentifier, eventUser, queryKey);
  const eventObject = getEventObject(eventType, eventIdentifier);
  const { eventEmitter } = eventObject;
  if (eventEmitter) {
    let handshakeData;
    response.write(`event: handshake\ndata: ${JSON.stringify({ status: 'connected', handshakeData })}\n\n`);

    eventEmitter.on('update', (data) => {
      response.write(`event: update\ndata: ${JSON.stringify(data)}\n\n`);
    });

    eventEmitter.on('server-restarting', (data) => {
      response.write(`event: server-restarting\ndata: ${JSON.stringify(data)}\n\n`);
    });
  }
  return;
}