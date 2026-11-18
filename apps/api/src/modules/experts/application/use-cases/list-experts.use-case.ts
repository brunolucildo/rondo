import type { Expert } from "../../domain/expert";
import { EXPERTS } from "../../domain/expert-catalog";

/** The catalog of experts, in display order. Fixed in code: there is nothing to look up. */
export class ListExperts {
  constructor(private readonly catalog: readonly Expert[] = EXPERTS) {}

  execute(): readonly Expert[] {
    return this.catalog;
  }
}
