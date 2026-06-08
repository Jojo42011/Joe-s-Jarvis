export const RESEARCH_DOMAINS = [
  {
    id: "landscaping",
    label: "Landscaping & Design",
    memory_category: "industry",
    interval_days: 4,
    importance: 0.8,
    system_state_key: "domain_last_run_landscaping",
    query_guidance: `
      Focus on: commercial landscaping trends, landscape design 
      techniques, plant material pricing, equipment updates, 
      seasonal maintenance best practices, Ohio-specific 
      landscaping conditions, irrigation systems, hardscape 
      trends, turf management, snow removal techniques.
      Joe runs a multimillion dollar landscaping operation 
      in Holmes County Ohio. Prioritize practical operational 
      intelligence he can act on.
    `,
    seed_queries: [
      "commercial landscaping trends 2026",
      "landscape design techniques Ohio",
      "landscaping equipment updates 2026",
      "turf management best practices",
      "hardscape design trends"
    ]
  },
  {
    id: "business_management",
    label: "Business Management & Operations",
    memory_category: "business_context",
    interval_days: 4,
    importance: 0.85,
    system_state_key: "domain_last_run_business",
    query_guidance: `
      Focus on: small business operations, crew management, 
      scheduling optimization, client retention strategies,
      operational efficiency, subcontractor management,
      seasonal business planning, business growth strategies
      for service businesses, Ohio business regulations,
      insurance and bonding updates for contractors.
    `,
    seed_queries: [
      "small business operations best practices 2026",
      "crew management strategies contractors",
      "client retention landscaping service business",
      "Ohio contractor regulations 2026",
      "seasonal business cash flow management"
    ]
  },
  {
    id: "finance",
    label: "Finance & Business Funding",
    memory_category: "financial_operations",
    interval_days: 3,
    importance: 0.9,
    system_state_key: "domain_last_run_finance",
    query_guidance: `
      Focus on: small business grants, SBA loans, Ohio business
      funding programs, equipment financing, landscaping 
      business funding, interest rates for business loans,
      invoice factoring, cash flow management tools,
      tax deductions for landscaping businesses, 
      USDA rural business grants, Ohio development grants,
      bonding requirements and costs.
    `,
    seed_queries: [
      "small business grants Ohio 2026",
      "SBA loans landscaping business 2026",
      "equipment financing rates 2026",
      "Ohio business development funding programs",
      "landscaping business tax deductions 2026"
    ]
  },
  {
    id: "investment",
    label: "Investment & Wealth Building",
    memory_category: "financial_operations",
    interval_days: 5,
    importance: 0.75,
    system_state_key: "domain_last_run_investment",
    query_guidance: `
      Focus on: business owner investment strategies,
      real estate investment for business owners,
      retirement planning for small business owners,
      equipment as investment, business valuation,
      exit strategy planning, passive income for 
      service business owners, Ohio real estate market.
    `,
    seed_queries: [
      "investment strategies small business owners 2026",
      "real estate investment Ohio 2026",
      "retirement planning self employed business owner",
      "business valuation landscaping company"
    ]
  },
  {
    id: "world_affairs",
    label: "World Affairs & Economy",
    memory_category: "world_intel",
    interval_days: 7,
    importance: 0.6,
    system_state_key: "domain_last_run_world",
    query_guidance: `
      Focus on: economic news affecting small businesses,
      supply chain updates affecting landscaping materials,
      fuel and energy prices, tariff impacts on equipment
      and materials, labor market conditions, inflation
      trends, interest rate changes, weather pattern 
      forecasts for midwest/Ohio region.
      Filter for business relevance — skip pure politics.
    `,
    seed_queries: [
      "supply chain landscaping materials 2026",
      "fuel prices impact small business 2026",
      "US economy small business outlook 2026",
      "midwest weather patterns summer 2026",
      "tariff impact construction materials 2026"
    ]
  },
  {
    id: "science_technology",
    label: "Science & Technology",
    memory_category: "world_intel",
    interval_days: 5,
    importance: 0.65,
    system_state_key: "domain_last_run_science",
    query_guidance: `
      Focus on: technology relevant to landscaping operations,
      GPS and mapping technology for job sites, telematics
      for equipment fleets, irrigation technology advances,
      environmental science affecting landscaping,
      climate and soil science, new materials and chemicals
      for lawn care, battery and electric equipment advances.
    `,
    seed_queries: [
      "GPS mapping technology landscaping 2026",
      "electric landscaping equipment advances 2026",
      "irrigation technology innovations 2026",
      "fleet telematics small business 2026"
    ]
  },
  {
    id: "ai_robotics",
    label: "AI & Robotics",
    memory_category: "world_intel",
    interval_days: 3,
    importance: 0.8,
    system_state_key: "domain_last_run_ai",
    query_guidance: `
      Focus on: AI tools for small business operations,
      autonomous mowing and landscaping robots, AI scheduling
      and dispatch tools, computer vision for job site 
      management, AI customer service tools, voice AI 
      advances, automation tools for field service businesses,
      robotics in outdoor maintenance, AI pricing tools.
    `,
    seed_queries: [
      "AI tools small business operations 2026",
      "autonomous mowing robots 2026",
      "AI scheduling dispatch field service 2026",
      "robotics landscaping maintenance 2026",
      "voice AI business automation 2026"
    ]
  },
  {
    id: "drone_faa",
    label: "Drones & FAA Regulations",
    memory_category: "drone_faa",
    interval_days: 3,
    importance: 0.85,
    system_state_key: "domain_last_run_drone",
    query_guidance: `
      Focus on: FAA drone regulations updates, Part 107 
      certification requirements, commercial drone use in
      landscaping and surveying, drone mapping software,
      Ohio drone laws and permits, BVLOS waivers, 
      drone inspection services, aerial photography 
      for landscaping bids, drone equipment for 
      commercial operators, insurance for drone operations.
    `,
    seed_queries: [
      "FAA drone regulations updates 2026",
      "Part 107 commercial drone requirements 2026",
      "drone mapping landscaping surveying 2026",
      "Ohio drone laws permits 2026",
      "commercial drone insurance requirements 2026"
    ]
  },
  {
    id: "legal_compliance",
    label: "Legal & Compliance",
    memory_category: "business_context",
    interval_days: 7,
    importance: 0.8,
    system_state_key: "domain_last_run_legal",
    query_guidance: `
      Focus on: Ohio contractor licensing requirements,
      employment law updates for small businesses,
      OSHA regulations for landscaping crews, 
      contract law for service businesses, liability
      insurance requirements, non-compete agreements,
      subcontractor classification rules, workers comp
      updates Ohio, lien rights for contractors.
    `,
    seed_queries: [
      "Ohio contractor licensing requirements 2026",
      "OSHA landscaping crew safety regulations 2026",
      "employment law updates small business Ohio 2026",
      "subcontractor classification rules 2026"
    ]
  },
  {
    id: "gold_silver",
    label: "Gold & Silver Markets",
    memory_category: "financial_operations",
    interval_days: 3,
    importance: 0.85,
    system_state_key: "domain_last_run_gold_silver",
    query_guidance: `
      Focus on: gold and silver spot prices, price trends and 
      forecasts, precious metals as inflation hedge, gold/silver 
      ratio, physical vs ETF investment, storing physical metals,
      best time to buy gold and silver, impact of Fed policy on 
      precious metals, Ohio precious metals dealers, 
      IRA gold investment rules, silver industrial demand trends.
      Joe is a business owner interested in wealth preservation
      and investment alongside running his landscaping operation.
    `,
    seed_queries: [
      "gold silver price forecast 2026",
      "precious metals inflation hedge strategy 2026",
      "physical gold silver investment small business owner",
      "gold silver ratio analysis 2026",
      "silver industrial demand outlook 2026"
    ]
  },
  {
    id: "china_russia_geopolitics",
    label: "China & Russia — Business Impact",
    memory_category: "world_intel",
    interval_days: 7,
    importance: 0.7,
    system_state_key: "domain_last_run_geopolitics",
    query_guidance: `
      Focus on: China and Russia economic activity that affects
      US small businesses — trade policy, tariffs on equipment
      and materials, supply chain disruptions, sanctions impact
      on material costs, energy prices from geopolitical tension,
      rare earth materials pricing, steel and aluminum tariffs,
      Chinese manufacturing updates affecting equipment costs.
      Filter for direct business impact only — not pure politics.
      Joe needs to know how global events hit his bottom line.
    `,
    seed_queries: [
      "China tariffs impact US construction materials 2026",
      "Russia sanctions energy prices US business 2026",
      "steel aluminum tariffs small business impact 2026",
      "China supply chain disruption equipment costs 2026",
      "rare earth materials pricing outlook 2026"
    ]
  },
  {
    id: "sba_loans",
    label: "SBA Loans & Government Funding",
    memory_category: "financial_operations",
    interval_days: 4,
    importance: 0.95,
    system_state_key: "domain_last_run_sba",
    query_guidance: `
      Focus on: SBA 7(a) loans, SBA 504 loans, SBA microloans,
      current SBA interest rates, SBA loan requirements for
      landscaping businesses, how to qualify for SBA funding,
      SBA express loans, USDA business loans for rural Ohio,
      Ohio small business loan programs, economic injury 
      disaster loans, SBA equipment financing, working capital
      loans, SBA lenders in Ohio, application process updates,
      current SBA approval rates and timelines.
      This is high priority — Joe may use this for expansion.
    `,
    seed_queries: [
      "SBA loan rates requirements 2026",
      "SBA 7a 504 loan landscaping business 2026",
      "Ohio SBA lenders approval rates 2026",
      "USDA rural business loan Ohio 2026",
      "SBA equipment financing small business 2026"
    ]
  },
  {
    id: "hardscape_construction",
    label: "Hardscape — Paving, Retaining Walls & Construction",
    memory_category: "industry",
    interval_days: 5,
    importance: 0.85,
    system_state_key: "domain_last_run_hardscape",
    query_guidance: `
      Focus on: paver installation techniques and trends,
      retaining wall design and construction methods,
      retaining wall materials (Allan block, natural stone,
      concrete block, timber), drainage solutions behind
      retaining walls, permit requirements for retaining walls
      Ohio, paver pricing and material costs 2026,
      segmental retaining wall engineering, erosion control,
      grading and excavation best practices, commercial
      hardscape project estimating, retaining wall failure
      prevention, geogrid reinforcement techniques.
    `,
    seed_queries: [
      "retaining wall construction techniques 2026",
      "paver installation trends commercial 2026",
      "retaining wall materials pricing 2026",
      "Ohio retaining wall permit requirements",
      "segmental retaining wall engineering best practices"
    ]
  },
  {
    id: "synthetic_turf",
    label: "Synthetic Grass & Putting Greens",
    memory_category: "industry",
    interval_days: 5,
    importance: 0.85,
    system_state_key: "domain_last_run_synthetic",
    query_guidance: `
      Focus on: synthetic turf installation techniques,
      synthetic grass product comparisons and pricing,
      residential vs commercial synthetic turf applications,
      putting green installation — design, base preparation,
      drainage, turf selection, fringe and cup placement,
      synthetic turf maintenance, infill materials (crumb rubber,
      sand, cork, organic), synthetic turf for Ohio climate
      (freeze/thaw considerations), synthetic turf warranties,
      lead times from suppliers, synthetic turf vs natural grass
      ROI for clients, marketing synthetic turf services,
      cost per square foot installed, common installation mistakes.
    `,
    seed_queries: [
      "synthetic turf installation techniques commercial 2026",
      "putting green installation residential design 2026",
      "synthetic grass pricing per square foot 2026",
      "synthetic turf infill materials comparison 2026",
      "artificial turf Ohio climate considerations"
    ]
  },
  {
    id: "hardscape_mastery",
    label: "Hardscape — Walls, Patios, Rock & Beds",
    memory_category: "industry",
    interval_days: 4,
    importance: 0.95,
    system_state_key: "domain_last_run_hardscape_mastery",
    query_guidance: `
      Deep expertise in: retaining wall construction 
      (segmental block, natural stone, boulder walls, 
      timber), patio design and installation (pavers, 
      flagstone, concrete, stamped), rock wall construction
      techniques, raised garden beds (stone, block, timber),
      dry stack vs mortared walls, wall drainage systems,
      geogrid reinforcement, batter and setback calculations,
      cap and coping details, corner and curve techniques,
      Ohio frost line considerations (42 inches), 
      wall failure causes and prevention, load-bearing 
      calculations, permit requirements by county Ohio,
      material estimating (tons, square feet, linear feet),
      pricing per square foot installed, supplier sources
      in Ohio, equipment needed per job type.
    `,
    seed_queries: [
      "retaining wall construction techniques block stone 2026",
      "patio paver installation best practices 2026",
      "segmental retaining wall geogrid reinforcement",
      "Ohio frost line retaining wall design",
      "hardscape material pricing Ohio 2026"
    ]
  },
  {
    id: "plants_trees_ohio",
    label: "Ohio Plants, Trees & Flowers — Zone 5/6",
    memory_category: "industry",
    interval_days: 5,
    importance: 0.9,
    system_state_key: "domain_last_run_plants_ohio",
    query_guidance: `
      Deep expertise in: Ohio hardiness zones (5b/6a),
      native Ohio trees (oak, maple, buckeye, redbud,
      dogwood, serviceberry), ornamental trees for 
      commercial landscaping, shrubs for Ohio climate
      (arborvitae, boxwood, spirea, viburnum, ninebark),
      perennial flowers for Ohio (coneflower, black-eyed
      susan, sedum, ornamental grasses, hostas),
      annual flowers for color (petunias, marigolds,
      begonias, impatiens for shade), ground covers,
      plant spacing and layout principles, soil 
      amendments for Ohio clay soil, planting seasons,
      winter hardiness, deer resistance, drought 
      tolerance, shade vs sun requirements, plant
      pricing wholesale vs retail Ohio, nursery sources,
      plant health and disease identification, pruning
      schedules, mulching best practices.
    `,
    seed_queries: [
      "Ohio zone 5 6 landscaping plants trees 2026",
      "native Ohio trees commercial landscaping",
      "perennial flowers Ohio hardiness zone 5",
      "Ohio clay soil plant selection amendments",
      "commercial landscape plant pricing Ohio 2026"
    ]
  },
  {
    id: "excavation_drainage",
    label: "Excavation, Drainage, Grading & Installation",
    memory_category: "industry",
    interval_days: 5,
    importance: 0.95,
    system_state_key: "domain_last_run_excavation",
    query_guidance: `
      Deep expertise in: site grading and slope 
      calculations, French drain installation (trench
      depth, pipe sizing, stone selection, outlet),
      surface drainage patterns, swales and berms,
      catch basins and area drains, downspout 
      drainage solutions, lawn installation (seed vs
      sod, soil prep, grading to 2% slope away from
      structure), driveway installation (base prep,
      compaction, asphalt vs concrete vs gravel),
      excavation techniques (cut and fill, bench
      cutting, soil types), underground utility 
      awareness, erosion control during construction,
      dewatering techniques, compaction testing,
      subbase materials (limestone, #57 stone, 
      crusher run), equipment selection per task,
      Ohio soil types (clay-heavy northeast Ohio),
      permit requirements for grading Ohio,
      job site safety during excavation,
      estimating cut/fill volumes (cubic yards).
    `,
    seed_queries: [
      "French drain installation techniques residential 2026",
      "site grading drainage slope best practices",
      "lawn installation grading prep sod seed",
      "driveway base installation compaction Ohio",
      "excavation drainage Ohio clay soil solutions"
    ]
  },
  {
    id: "equipment_mastery",
    label: "Equipment — Mini Ex, Skid Steer, Loader, Mechanics",
    memory_category: "industry",
    interval_days: 6,
    importance: 0.9,
    system_state_key: "domain_last_run_equipment",
    query_guidance: `
      Complete mechanic and operator knowledge for:
      
      MINI EXCAVATORS: Yanmar, Cat, Case — hydraulic 
      systems, track tension, bucket and attachment
      selection, digging techniques, tight space work,
      maintenance schedules, common failures (final
      drives, swing bearings, hydraulic pumps),
      bucket sizing for soil types, thumb attachments.
      
      SKID STEERS & TRACK LOADERS: Case, Cat — 
      hydraulic quick attach, bucket vs forks vs 
      auger vs grapple selection, track replacement,
      chain and sprocket wear, loader arm maintenance,
      weight capacity calculations, attachment 
      compatibility, tire selection for skid steers.
      
      TRACK DUMP TRUCKS: operation, load capacity,
      maintenance, track systems, hydraulic dump beds.
      
      VOLVO FRONT END LOADER: bucket sizing, 
      breakout force, transmission service, 
      hydraulic system maintenance, tire service.
      
      GENERAL MECHANIC: hydraulic fluid diagnosis,
      engine oil analysis, fuel system maintenance,
      electrical troubleshooting, battery systems,
      DEF systems on newer equipment, winter storage
      and startup procedures, equipment hour tracking,
      preventive maintenance schedules, when to repair
      vs replace, parts sourcing (dealers vs aftermarket),
      Ohio equipment dealers (Case, Cat, Yanmar, Volvo).
    `,
    seed_queries: [
      "mini excavator maintenance troubleshooting 2026",
      "skid steer track loader hydraulic system repair",
      "Case Cat equipment common failures solutions",
      "Yanmar excavator maintenance schedule parts",
      "landscaping equipment preventive maintenance Ohio"
    ]
  },
  {
    id: "negotiation_business",
    label: "Negotiation, Sales & Business Strategy",
    memory_category: "business_context",
    interval_days: 5,
    importance: 0.95,
    system_state_key: "domain_last_run_negotiation",
    query_guidance: `
      Deep expertise in: negotiation tactics for 
      service businesses (when to hold firm, when to
      discount, how to anchor price high), closing
      techniques for landscaping estimates, handling
      price objections ("I got a cheaper quote"),
      upselling and add-on strategies, how to present
      value not just price, contract negotiation with
      commercial clients, payment terms negotiation,
      vendor price negotiation (bulk discounts, 
      payment terms, exclusivity), employee/crew 
      compensation negotiation, subcontractor 
      agreements, equipment purchase vs lease 
      negotiation, client retention strategies,
      firing bad clients professionally, raising
      prices on existing clients, referral programs,
      how to win commercial accounts, HOA and 
      property management relationships, seasonal
      contract pricing, change order management,
      how the best service businesses price and sell,
      business growth strategy for trades businesses,
      when and how to hire, scaling operations.
    `,
    seed_queries: [
      "negotiation tactics service business contractors",
      "landscaping estimate closing techniques 2026",
      "price objection handling contractor business",
      "commercial landscaping account acquisition strategy",
      "scaling landscaping business operations 2026"
    ]
  }
] as const;

export type ResearchDomain = (typeof RESEARCH_DOMAINS)[number];
export type DomainId = ResearchDomain["id"];

export function getResearchDomainById(id: string): ResearchDomain | undefined {
  return RESEARCH_DOMAINS.find((d) => d.id === id);
}
