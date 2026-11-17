import { LANES, type LaneName, type ProjectItem } from '../types.ts';
import type { GitHubClient } from './client.ts';

interface ProjectMetadata {
  projectId: string;
  statusFieldId: string;
  laneOptionIds: Map<string, string>;
}

const PROJECT_QUERY_USER = `
query($owner: String!, $number: Int!) {
  user(login: $owner) {
    projectV2(number: $number) {
      id
      field(name: "Status") {
        ... on ProjectV2SingleSelectField {
          id
          options {
            id
            name
          }
        }
      }
    }
  }
}`;

const PROJECT_QUERY_ORG = `
query($owner: String!, $number: Int!) {
  organization(login: $owner) {
    projectV2(number: $number) {
      id
      field(name: "Status") {
        ... on ProjectV2SingleSelectField {
          id
          options {
            id
            name
          }
        }
      }
    }
  }
}`;

const PROJECT_ITEMS_QUERY = `
query($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue {
              name
            }
          }
          content {
            ... on Issue {
              number
              title
              body
              url
              state
              repository {
                name
                owner {
                  login
                }
              }
              labels(first: 50) {
                nodes {
                  name
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const UPDATE_LANE_MUTATION = `
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(
    input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { singleSelectOptionId: $optionId }
    }
  ) {
    projectV2Item {
      id
    }
  }
}`;

export class GitHubProjectsClient {
  private readonly client: GitHubClient;
  private readonly owner: string;
  private readonly repo: string;
  private readonly projectNumber: number;
  private metadata: ProjectMetadata | null = null;

  constructor(client: GitHubClient, owner: string, repo: string, projectNumber: number) {
    this.client = client;
    this.owner = owner;
    this.repo = repo;
    this.projectNumber = projectNumber;
  }

  async init(): Promise<ProjectMetadata> {
    if (this.metadata) return this.metadata;

    let project: {
      id: string;
      field: { id: string; options: Array<{ id: string; name: string }> } | null;
    } | null = null;

    try {
      const userRes = await this.client.graphql<{
        user: { projectV2: typeof project } | null;
      }>(PROJECT_QUERY_USER, { owner: this.owner, number: this.projectNumber });
      project = userRes.user?.projectV2 ?? null;
    } catch {
      project = null;
    }

    if (!project) {
      const orgRes = await this.client.graphql<{
        organization: { projectV2: typeof project } | null;
      }>(PROJECT_QUERY_ORG, { owner: this.owner, number: this.projectNumber });
      project = orgRes.organization?.projectV2 ?? null;
    }

    if (!project) {
      throw new Error(`Could not find GitHub Project #${this.projectNumber} under ${this.owner}`);
    }
    if (!project.field) {
      throw new Error(`GitHub Project #${this.projectNumber} does not have a "Status" field`);
    }

    const laneOptionIds = new Map<string, string>();
    for (const opt of project.field.options) {
      laneOptionIds.set(opt.name.toLowerCase(), opt.id);
    }

    const requiredLanes = Object.values(LANES);
    for (const lane of requiredLanes) {
      if (!laneOptionIds.has(lane.toLowerCase())) {
        throw new Error(
          `GitHub Project #${this.projectNumber} is missing required lane "${lane}". Found: ${project.field.options.map((o) => o.name).join(', ')}`,
        );
      }
    }

    this.metadata = {
      projectId: project.id,
      statusFieldId: project.field.id,
      laneOptionIds,
    };
    return this.metadata;
  }

  async listItems(): Promise<ProjectItem[]> {
    const meta = await this.init();
    const items: ProjectItem[] = [];
    let cursor: string | null = null;

    do {
      const res: {
        node: {
          items: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{
              id: string;
              fieldValueByName: { name?: string } | null;
              content: {
                number?: number;
                title?: string;
                body?: string;
                url?: string;
                state?: 'OPEN' | 'CLOSED';
                repository?: { name: string; owner: { login: string } };
                labels?: { nodes: Array<{ name: string }> };
              } | null;
            }>;
          };
        };
      } = await this.client.graphql(PROJECT_ITEMS_QUERY, {
        projectId: meta.projectId,
        cursor,
      });

      for (const node of res.node.items.nodes) {
        const content = node.content;
        if (!content || typeof content.number !== 'number' || !content.repository) continue;
        if (
          content.repository.owner.login.toLowerCase() !== this.owner.toLowerCase() ||
          content.repository.name.toLowerCase() !== this.repo.toLowerCase()
        ) {
          continue;
        }
        items.push({
          itemId: node.id,
          lane: node.fieldValueByName?.name || '',
          issueNumber: content.number,
          issueTitle: content.title || '',
          issueBody: content.body || '',
          issueUrl: content.url || '',
          labels: (content.labels?.nodes || []).map((l) => l.name),
          state: content.state || 'OPEN',
        });
      }

      cursor = res.node.items.pageInfo.hasNextPage ? res.node.items.pageInfo.endCursor : null;
    } while (cursor);

    return items;
  }

  async moveItemToLane(projectItemId: string, lane: LaneName): Promise<void> {
    const meta = await this.init();
    const optionId = meta.laneOptionIds.get(lane.toLowerCase());
    if (!optionId) {
      throw new Error(`Unknown lane "${lane}"`);
    }
    await this.client.graphql(UPDATE_LANE_MUTATION, {
      projectId: meta.projectId,
      itemId: projectItemId,
      fieldId: meta.statusFieldId,
      optionId,
    });
  }
}
