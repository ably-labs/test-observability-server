import pluralize from 'pluralize';
import {UploadsFilter} from 'src/uploads/uploads.service';
import {ViewModelHelpers} from 'src/utils/viewModel/helpers';
import {ViewModelURLHelpers} from 'src/utils/viewModel/urlHelpers';
import {TestCase} from '../uploads/testCase.entity'
import {TableViewModel} from "../utils/view/table";

export class TestCaseViewModel {
  constructor(private readonly testCase: TestCase, private readonly filter: UploadsFilter | null) {}

  readonly filterDescription = ViewModelHelpers.viewModelForFilter(this.filter)

  get heading(): string {
    return `Failures in ${this.testCase.testClassName}.${this.testCase.testCaseName}`
  }

  readonly tableIntroText = `There ${this.testCase.failures.length == 1 ? "is" : "are"} ${this.testCase.failures.length} recorded ${pluralize("failure", this.testCase.failures.length)} of this test case.`

  readonly occurrencesTable: TableViewModel = {
    headers: ['Upload ID', 'Message'],
    rows: this.testCase.failures.map(failure => [
      {type: "link", text: failure.uploadId, href: ViewModelURLHelpers.hrefForUploadDetails(failure.uploadId)},
      {type: "text", text: failure.message}
    ])
  }
}
