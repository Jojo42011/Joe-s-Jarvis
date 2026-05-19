export const MEMORY_CATEGORIES = {
  BUSINESS_CONTEXT: "business_context",
  CLIENT_RELATIONS: "client_relations",
  OPERATOR_PREFERENCES: "operator_preferences",
  WORLD_INTEL: "world_intel",
  CREW_LABOR: "crew_labor",
  VENDOR_SUPPLIER: "vendor_supplier",
  DRONE_FAA: "drone_faa",
  INDUSTRY: "industry",
  DOCUMENT_FACTS: "document_facts"
} as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[keyof typeof MEMORY_CATEGORIES];

export const MEMORY_CATEGORY_LIST: MemoryCategory[] = Object.values(MEMORY_CATEGORIES);

export const MEMORY_NEVER_DECAY: MemoryCategory[] = [
  MEMORY_CATEGORIES.OPERATOR_PREFERENCES,
  MEMORY_CATEGORIES.CLIENT_RELATIONS
];

/** ReAct / legacy domain slugs → unified category */
export const REACT_DOMAIN_TO_CATEGORY: Record<string, MemoryCategory> = {
  weather: MEMORY_CATEGORIES.WORLD_INTEL,
  supply_chain: MEMORY_CATEGORIES.VENDOR_SUPPLIER,
  local: MEMORY_CATEGORIES.BUSINESS_CONTEXT,
  world: MEMORY_CATEGORIES.WORLD_INTEL,
  industry: MEMORY_CATEGORIES.INDUSTRY,
  drone_faa: MEMORY_CATEGORIES.DRONE_FAA,
  crew_labor: MEMORY_CATEGORIES.CREW_LABOR,
  business_context: MEMORY_CATEGORIES.BUSINESS_CONTEXT,
  client_relations: MEMORY_CATEGORIES.CLIENT_RELATIONS,
  operator_preferences: MEMORY_CATEGORIES.OPERATOR_PREFERENCES,
  world_intel: MEMORY_CATEGORIES.WORLD_INTEL,
  vendor_supplier: MEMORY_CATEGORIES.VENDOR_SUPPLIER,
  document_facts: MEMORY_CATEGORIES.DOCUMENT_FACTS,
  preferences: MEMORY_CATEGORIES.OPERATOR_PREFERENCES,
  contact_priority: MEMORY_CATEGORIES.CLIENT_RELATIONS,
  communication_style: MEMORY_CATEGORIES.OPERATOR_PREFERENCES,
  decision_patterns: MEMORY_CATEGORIES.OPERATOR_PREFERENCES,
  schedule_patterns: MEMORY_CATEGORIES.BUSINESS_CONTEXT
};

export function normalizeMemoryCategory(raw: string): MemoryCategory {
  const key = raw.trim().toLowerCase();
  if ((MEMORY_CATEGORY_LIST as string[]).includes(key)) {
    return key as MemoryCategory;
  }
  return REACT_DOMAIN_TO_CATEGORY[key] || MEMORY_CATEGORIES.BUSINESS_CONTEXT;
}
