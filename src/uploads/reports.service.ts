import {InjectRepository} from "@nestjs/typeorm";
import {Repository} from "typeorm";
import {Failure} from "./failure.entity";
import {TestCase} from "./testCase.entity";
import {Upload} from "./upload.entity";
import {UploadsFilter} from "./uploads.service";

type UploadsReportEntry = {
  upload: Pick<Upload, 'id' | 'createdAt' | 'githubHeadRef' | 'iteration'>
  numberOfTests: number
  numberOfFailures: number
}

export type UploadsReport = UploadsReportEntry[]

interface FailuresOverviewReportEntry {
  testCase: Pick<TestCase, 'id' | 'testClassName' | 'testCaseName'>
  occurrenceCount: number
  lastSeenIn: Pick<Upload, 'id' | 'createdAt'>
}

export type FailuresOverviewReport = FailuresOverviewReportEntry[]

class WhereClause {
  constructor(private readonly uploadsSubClauses: string[], private readonly failuresSubClauses: string[], readonly params: unknown[]) {}

  private createClause(subClauses: string[]): string | null {
    if (subClauses.length == 0) {
      return null
    }

    return `WHERE ${subClauses.join(' AND ')}`
  }

  get uploadsClause(): string | null {
    return this.createClause(this.uploadsSubClauses)
  }

  get uploadsAndFailuresClause(): string | null {
    return this.createClause(this.uploadsSubClauses.concat(this.failuresSubClauses))
  }
}

export class ReportsService {
  constructor(@InjectRepository(Upload) private uploadsRepository: Repository<Upload>, @InjectRepository(TestCase) private testCasesRepository: Repository<TestCase>) {}

  // OK, now I really wish I were using the ORM
  private createWhereClause(filter: UploadsFilter | null): WhereClause {
    let uploadsSubClauses: string[] = []
    let failuresSubClauses: string[] = []
    let params: unknown[] = []

    let parameterCount = 0

    if (filter?.branches?.length) {
      parameterCount += 1
      // https://github.com/brianc/node-postgres/wiki/FAQ#11-how-do-i-build-a-where-foo-in--query-to-find-rows-matching-an-array-of-values
      uploadsSubClauses.push(`uploads.github_head_ref = ANY ($${parameterCount})`)
      params.push(filter.branches)
    }

    if (filter?.createdBefore) {
      parameterCount += 1
      uploadsSubClauses.push(`uploads.created_at < $${parameterCount}`)
      params.push(filter.createdBefore)
    }

    if (filter?.createdAfter) {
      parameterCount += 1
      uploadsSubClauses.push(`uploads.created_at > $${parameterCount}`)
      params.push(filter.createdAfter)
    }

    if (filter?.failureMessage) {
      parameterCount += 1
      // The ::text cast is to avoid an error from Postgres that I don’t really understand: "could not determine data type of parameter $1"
      failuresSubClauses.push(`failures.message ILIKE CONCAT('%', $${parameterCount}::text, '%')`)
      const escapedFailureMessage = filter.failureMessage.replace('%', '\\%').replace('_', '\\_')
      params.push(escapedFailureMessage)
    }

    return new WhereClause(uploadsSubClauses, failuresSubClauses, params)
  }

  async createUploadsReport(filter: UploadsFilter | null): Promise<UploadsReport> {
    const whereClause = this.createWhereClause(filter)

    const sql = `SELECT
    uploads.id,
    uploads.created_at,
    uploads.github_head_ref,
    uploads.iteration,
    uploads.number_of_tests,
    COUNT(failures.id) AS number_of_failures
FROM
    uploads
    LEFT JOIN failures ON (uploads.id = failures.upload_id)
${whereClause.uploadsAndFailuresClause ?? ""}
GROUP BY
    uploads.id
ORDER BY
    uploads.created_at ASC`

    // See comment in subsequent method about learning how not to do this manually
    let results: Record<string, any>[] = await this.uploadsRepository.query(sql, whereClause.params)

    /* The result is an array of objects like this:
       {
          id: 'f26f0d3d-a135-4b15-b886-d997ccbe9d25',
          created_at: 2022-02-15T14:43:34.851Z,
          iteration: 1,
          number_of_tests: 999,
          number_of_failures: '3'
       }
    */

    return results.map(row => ({
      upload: {
        id: row['id'],
        createdAt: row['created_at'],
        githubHeadRef: row['github_head_ref'],
        iteration: row['iteration'],
      },
      numberOfTests: row['number_of_tests'],
      numberOfFailures: Number(row['number_of_failures'])
    }))
  }

  async createFailuresOverviewReport(filter: UploadsFilter | null): Promise<FailuresOverviewReport> {
    const whereClause = this.createWhereClause(filter)

    // I’ve not written SQL for ages and nothing this complicated for even longer, so let’s think this through…

    // 1. Get a table of all of the test cases that have at least one failure, along with the occurrence count.

    // test_cases.id ... (other test_cases columns) ...   failure_occurrence_count
    // 2                          ...                     ...
    // 3                          ...                     ...
    // 9                          ...                     ...

    // 2. Now for each of those test cases, we need to get the most recent upload that has a failure for that test case.
    //
    // https://stackoverflow.com/questions/22221925/get-id-of-max-value-in-group/22222052
    // So, the strategy is to create a temporary table that has the max for each test case…

    // test_case_id  latest_failing_upload_created_at
    // 2             ...
    // 3             ...
    // 9             ...

    // …and then join this back to the uploads table (as latest_failing_upload), to find _an_ (which, we can pick arbitrarily and treat as _the_) upload whose created_at matches that:

    // test_case_id  latest_failing_upload.id ...
    // 2             ...
    // 3             ...
    // 9             ...

    // This does not take the failure _message_ into account, i.e. the same
    // test case could be failing for different reasons each time.

    const sql = `SELECT
          test_cases.id AS test_case_id,
          test_cases.test_class_name,
          test_cases.test_case_name,
          failure_occurrence_count,
          uploads.id AS last_seen_in_upload_id,
          uploads.created_at AS last_seen_in_upload_created_at
      FROM (
          SELECT
              test_cases.*,
              COUNT(*) AS failure_occurrence_count
          FROM
              test_cases
              JOIN failures ON test_cases.id = failures.test_case_id
              JOIN uploads ON failures.upload_id = uploads.id
          ${whereClause.uploadsAndFailuresClause ?? ""}
          GROUP BY
              test_cases.id) AS test_cases
          JOIN (
              SELECT
                  test_cases.id AS test_case_id,
                  MAX(uploads.created_at) AS latest_failing_upload_created_at
              FROM
                  test_cases
                  JOIN failures ON test_cases.id = failures.test_case_id
                  JOIN uploads ON failures.upload_id = uploads.id
              ${whereClause.uploadsAndFailuresClause ?? ""}
              GROUP BY
                  test_cases.id) AS latest_failing_upload_dates ON test_cases.id = latest_failing_upload_dates.test_case_id
          JOIN uploads ON uploads.created_at = latest_failing_upload_created_at
      ${whereClause.uploadsClause ?? ""}
      ORDER BY
          failure_occurrence_count DESC`


    /* The result is an array of objects like this:
     
       {
         test_case_id: '8e0c0506-aa03-4545-b636-287b54b0b30d',
         test_class_name: 'RealtimeClientPresenceTests',
         test_case_name: 'test__015__Presence__subscribe__with_no_arguments_should_subscribe_a_listener_to_all_presence_messages()',
         failure_occurrence_count: '18',
         last_seen_in_upload_id: '867e4a40-46d4-4a9f-a7e8-7b520a301dcc',
         last_seen_in_upload_created_at: 2022-02-16T14:28:14.810Z
       }

      I'll just handle them manually. Would be good to understand sometime how I could have made more use of
      TypeORM to run the query / handle the resuts.
    */

    let results: Record<string, any>[] = await this.testCasesRepository.query(sql, whereClause.params)

    return results.map(row => ({
      testCase: {
        id: row['test_case_id'],
        testClassName: row['test_class_name'],
        testCaseName: row['test_case_name']
      },
      occurrenceCount: Number(row['failure_occurrence_count']),
      lastSeenIn: {
        id: row['last_seen_in_upload_id'],
        createdAt: row['last_seen_in_upload_created_at']
      }
    }))
  }

  async fetchSeenBranchNames(): Promise<string[]> {
    const sql = `SELECT DISTINCT
        uploads.github_head_ref AS branch
    FROM
        uploads
    ORDER BY
        branch ASC`

    // See comment in subsequent method about learning how not to do this manually
    let results: Record<string, any>[] = await this.uploadsRepository.query(sql)

    /* The result is an array of objects like this:
       {
          branch: 'main'
       }
    */

    return results.map(row => row['branch'])
  }
}

