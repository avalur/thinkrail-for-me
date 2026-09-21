import type {
	HubAccountStatusChangedPayload,
	HubMessageReceivedPayload,
	HubSyncStatusPayload,
} from "@thinkrail/contracts";

export type HubMessagePublisher = (payload: HubMessageReceivedPayload) => void;
export type HubAccountStatusPublisher = (payload: HubAccountStatusChangedPayload) => void;
export type HubSyncStatusPublisher = (payload: HubSyncStatusPayload) => void;

let hubMessagePublisher: HubMessagePublisher | null = null;
let hubAccountStatusPublisher: HubAccountStatusPublisher | null = null;
let hubSyncStatusPublisher: HubSyncStatusPublisher | null = null;

export function setHubMessagePublisher(fn: HubMessagePublisher | null): void {
	hubMessagePublisher = fn;
}

export function publishHubMessage(payload: HubMessageReceivedPayload): void {
	hubMessagePublisher?.(payload);
}

export function setHubAccountStatusPublisher(fn: HubAccountStatusPublisher | null): void {
	hubAccountStatusPublisher = fn;
}

export function publishHubAccountStatus(payload: HubAccountStatusChangedPayload): void {
	hubAccountStatusPublisher?.(payload);
}

export function setHubSyncStatusPublisher(fn: HubSyncStatusPublisher | null): void {
	hubSyncStatusPublisher = fn;
}

export function publishHubSyncStatus(payload: HubSyncStatusPayload): void {
	hubSyncStatusPublisher?.(payload);
}

export function setHubPublishers(publishers: {
	publishMessage?: HubMessagePublisher | null;
	publishAccountStatus?: HubAccountStatusPublisher | null;
	publishSyncStatus?: HubSyncStatusPublisher | null;
}): void {
	if (publishers.publishMessage !== undefined) {
		setHubMessagePublisher(publishers.publishMessage);
	}
	if (publishers.publishAccountStatus !== undefined) {
		setHubAccountStatusPublisher(publishers.publishAccountStatus);
	}
	if (publishers.publishSyncStatus !== undefined) {
		setHubSyncStatusPublisher(publishers.publishSyncStatus);
	}
}
