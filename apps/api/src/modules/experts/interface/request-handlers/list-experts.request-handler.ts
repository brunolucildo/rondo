import { Controller, Get, Inject } from "@nestjs/common";
import { ListExperts } from "../../application/use-cases/list-experts.use-case";
import { type ExpertResponse, presentExpert } from "../presenters/expert.presenter";

@Controller("experts")
export class ListExpertsRequestHandler {
  constructor(@Inject(ListExperts) private readonly listExperts: ListExperts) {}

  /** The catalog of experts (closed by default: needs a session). No system prompt, no avatar. */
  @Get()
  handle(): { experts: ExpertResponse[] } {
    return { experts: this.listExperts.execute().map(presentExpert) };
  }
}
