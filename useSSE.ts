/* eslint-disable no-param-reassign */
/* eslint-disable no-console */
import { next as A } from '@automerge/automerge';
import { onBeforeUnmount, ref, getCurrentInstance, watch } from 'vue';
import { PANDO_API_URL } from '@/scripts/Configuration';
import { usePandoStore } from '@/stores/pando';

const pandoStore = usePandoStore();

/* eslint-disable no-undef */
const EVICTION_FETCH_OPTIONS: RequestInit = {
  credentials: 'include',
  method: 'POST',
  mode: 'cors',
  cache: 'no-cache' as RequestCache,
  headers: { 'Content-Type': 'application/json' },
};
/* eslint-enable no-undef */

type EventType = 'meeting' | 'shared-doc';

interface CreateEventSourceArguments {
  type: EventType,
  identifier: string,
  updateFunction: Function
  handshakeFunction?: Function
  queryKey?: 'meeting'
}

export function createEventSource({
  type,
  identifier,
  updateFunction,
  handshakeFunction,
  queryKey,
}: CreateEventSourceArguments) {
  const searchParams = new URLSearchParams({
    type,
    identifier,
    user: pandoStore.employee.uuid,
  });

  if (queryKey) {
    searchParams.append('queryKey', queryKey);
  }

  let reconnectAttempts = 0;
  const maxReconnectAttempts = 12; // 1 minute / 5 seconds = 12 attempts
  const reconnectIntervalId = ref<number | undefined>();

  const clearReconnectInterval = () => {
    if (reconnectIntervalId.value !== undefined) {
      clearInterval(reconnectIntervalId.value);
      reconnectIntervalId.value = undefined;
    }
  };

  const eventSourceUrl = `${PANDO_API_URL}/events?${searchParams}`;
  const event = ref<EventSource | null>(null);

  const namedHandshakeFunction = (data) => {
    if (handshakeFunction) handshakeFunction(data);
  };

  const namedUpdateFunction = (data) => {
    updateFunction(data);
  };

  const connectEventSource = () => {
    event.value = new EventSource(eventSourceUrl);

    if (event.value) {
      event.value.addEventListener('open', () => {
        clearInterval(reconnectIntervalId.value);
        reconnectAttempts = 0; // Reset reconnect attempts on successful connection
      });

      event.value.addEventListener('error', () => {
        event.value?.close(); // Close the current connection to attempt a fresh connection
        if (reconnectAttempts >= maxReconnectAttempts) {
          console.log('Max reconnect attempts reached. Stopping reconnection attempts.');
          clearInterval(reconnectIntervalId.value);
        }
      });

      event.value.addEventListener('handshake', (e) => {
        clearReconnectInterval();
        const data = JSON.parse(e.data);
        namedHandshakeFunction(data.handshakeData);

        if (data.status === 'connected') {
          event.value?.addEventListener('update', (eData) => {
            const updateData = JSON.parse(eData.data);
            namedUpdateFunction(updateData || identifier);
          });

          event.value?.addEventListener('server-restarting', () => {
            event.value?.close();

            // eslint-disable-next-line no-use-before-define
            attemptReconnect();
          });
        }
      }, { once: true });
    }
    return event;
  };

  const attemptReconnect = () => {
    clearReconnectInterval(); // Ensure there's no existing reconnection attempt running
    const intervalFunction = () => {
      reconnectIntervalId.value = setInterval(() => {
        reconnectAttempts += 1;
        console.log(`Attempting to reconnect... (Attempt ${reconnectAttempts}/${maxReconnectAttempts})`);
        if (reconnectAttempts < maxReconnectAttempts) connectEventSource();
      }, 5000);
    };
    // Attempt to reconnect immediately, then set an interval for further attempts
    setTimeout(intervalFunction, 5000);
  };

  const instance = ref(getCurrentInstance());

  watch(instance, () => {
    if (instance.value) {
      onBeforeUnmount(() => {
        clearReconnectInterval();
        if (event.value) {
          event.value.removeEventListener('update', namedUpdateFunction);
          // Also remove the rest of the event listeners
          event.value.close();
        }

        // Evict the user
        searchParams.append('evict', 'true');
        fetch(`${PANDO_API_URL}/events?${searchParams}`, EVICTION_FETCH_OPTIONS);
      });
    }
  }, { immediate: true });

  connectEventSource(); // Initially connect when component is mounted
  return { event };
}

interface useCollaborativeDocumentArgs {
  identifier: string
  queryKey: 'meeting'
  sharedDocumentRef: any
}

export function useSharedDocument({ identifier, queryKey, sharedDocumentRef }: useCollaborativeDocumentArgs) {
  // Create local document
  let doc: { text: string } = A.init();
  let syncState: A.SyncState = A.initSyncState();

  function sendSyncMessageToServer(syncMessage: any) {
    const syncMessageBase64 = btoa(String.fromCharCode.apply(null, syncMessage));
    fetch(`${PANDO_API_URL}/automerge-updates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Include any necessary headers
      },
      credentials: 'include',
      mode: 'cors',
      cache: 'no-cache',
      body: JSON.stringify({
        syncMessageBase64,
        identifier,
        queryKey,
        user: pandoStore.employee.uuid,
      }),
    });
  }

  function syncLocalDocWithHeadDoc() {
    let syncMessage;
    [syncState, syncMessage] = A.generateSyncMessage(doc, syncState);
    console.log(syncMessage, 'sync message in the handshake!');

    if (syncMessage) {
      sendSyncMessageToServer(syncMessage);
    }
  }

  function handleUpdate(data: { syncMessage: string, user: string | null }) {
    // Potentially add the user check back here
    if (data.user === pandoStore.employee.uuid) {
      const syncMessage = Uint8Array.from(atob(data.syncMessage), (c) => c.charCodeAt(0));
      let newSyncMessage;
      [doc, syncState, newSyncMessage] = A.receiveSyncMessage(doc, syncState, syncMessage);

      if (newSyncMessage) {
        sendSyncMessageToServer(newSyncMessage);
      }

      sharedDocumentRef.value = doc.text;
    }
  }

  // Open SSE Connection
  createEventSource({
    type: 'shared-doc',
    identifier,
    updateFunction: (data: { syncMessage: string, user: string | null }) => handleUpdate(data),
    handshakeFunction: (data: string) => syncLocalDocWithHeadDoc(data),
    queryKey,
  });

  function applyChange(newText: string) {
    doc = A.change(doc, 'Update text', (d) => {
      A.updateText(d, ['text'], newText);
    });
    // Generate a sync message after applying the change
    let syncMessage;
    [syncState, syncMessage] = A.generateSyncMessage(doc, syncState);

    if (syncMessage) {
      sendSyncMessageToServer(syncMessage);
    }
  }

  return { applyChange };
}
