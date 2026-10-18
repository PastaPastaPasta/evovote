import type { EvoSDK } from '@dashevo/evo-sdk';
import type { ArchivePage } from '../discovery/archive';
import type { Contender, Contest, ContestSummary, VoteChoiceKind } from '../model/contest';
import type { PollKey } from '../model/pollKey';

export type KindId = 'dpns' | 'charter' | 'generic';

/** A contender as a page shows it. Every field but the id is optional. */
export interface ContenderView {
  identityId: string;
  /** Headline, e.g. the requested username or the charter's leader name. */
  title?: string;
  /** One line of context, e.g. "also holds alice, bob". */
  subtitle?: string;
  /** Key/value rows (the generic kind shows the document's fields). */
  fields?: Array<[string, string]>;
  /** A page with more about this contender (a charter's proposal page). */
  link?: { href: string; label: string };
}

/**
 * One family of contested resources. Discovery finds polls; the registry
 * picks the first kind whose `matches` accepts the key (generic last, so
 * every poll has a kind and nothing is hidden).
 */
export interface ContestKind {
  id: KindId;
  /** Plural noun for list headings: "Usernames", "Moderator elections". */
  label: string;
  matches(key: PollKey): boolean;
  /** Plain-text title: "alice.dash", "Moderators of 7xYz…". */
  title(c: ContestSummary | Contest): string;
  /** A contender's view model; may read more from Platform (names, documents). */
  describeContender(sdk: EvoSDK, c: Contest, contender: Contender): Promise<ContenderView>;
  /** The choices the poll's index allows: no Lock for resolution 1. */
  choices(c: Contest): VoteChoiceKind[];
  /** Sweep of decided contests whose polls left the end-date index. */
  archive?: (sdk: EvoSDK) => AsyncIterable<ArchivePage>;
}
