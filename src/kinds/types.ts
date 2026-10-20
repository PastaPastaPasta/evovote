import type { EvoSDK } from '@dashevo/evo-sdk';
import type { ArchivePage } from '../discovery/archive';
import type { Contender, Contest, ContestSummary, VoteChoiceKind } from '../model/contest';
import type { PollKey } from '../model/pollKey';
import type { FieldRow } from './fields';

export type KindId = 'dpns' | 'charter' | 'generic';

/** A contender as a page shows it. Every field but the id is optional. */
export interface ContenderView {
  identityId: string;
  /** Headline, e.g. the requested username or the charter's leader name. */
  title?: string;
  /** One line of context, e.g. "also holds alice, bob". */
  subtitle?: string;
  /** Plain key/value rows. */
  fields?: Array<[string, string]>;
  /** Typed key/value rows (identifiers with copy buttons, bytes as hex). */
  rows?: FieldRow[];
  /** A page with more about this contender (a charter's proposal page). */
  link?: { href: string; label: string };
  /**
   * A moderator-election contender's charter. `null` means it was looked up
   * and none was found; undefined means not a charter contest (or not read).
   */
  charter?: CharterApplicationView | null;
}

/** The charter a moderator-election contender stands on, as the contest page shows it. */
export interface CharterApplicationView {
  description: string;
  /** Percent of the declared moderators fee the team takes. */
  moderatorsShare: number;
  rewardSplit?: { leader: number; equal: number; actions: number };
  /** "OFF Off-topic"; undefined when the reasons could not be read. */
  reasons?: Array<{ code: string; label: string }>;
  /**
   * The team besides the leader (names or short ids). Undefined when it is
   * not kept: a losing application's member list is gone once decided.
   */
  members?: string[];
  appliedAtMs?: number;
  href: string;
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
