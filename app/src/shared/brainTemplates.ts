/** Brain template gallery — shown in the create-workspace flow. Each id maps to
 *  a tuned CLAUDE.md in app/src/bun/workspaceTemplate.ts (same skills + folder
 *  structure everywhere; the CLAUDE.md is what makes a brain feel native to the
 *  business). Community: PR new verticals — metadata here, content there. */

export type BrainTemplateInfo = {
  id: string;
  name: string;
  description: string;
};

export const BRAIN_TEMPLATES: BrainTemplateInfo[] = [
  {
    id: "generic",
    name: "Generic",
    description: "Neutral starting point for any company.",
  },
  {
    id: "agency",
    name: "Agency / Studio",
    description:
      "Client work: retainers, projects, briefs, approvals, invoicing per client.",
  },
  {
    id: "ecommerce",
    name: "E-commerce",
    description:
      "Products, suppliers, orders, margins, campaigns, marketplace terms.",
  },
  {
    id: "saas",
    name: "SaaS",
    description:
      "Product metrics, churn, pricing, roadmap decisions, customer feedback.",
  },
  {
    id: "consultancy",
    name: "Consultancy",
    description: "Engagements, proposals, deliverables, day rates, references.",
  },
];
