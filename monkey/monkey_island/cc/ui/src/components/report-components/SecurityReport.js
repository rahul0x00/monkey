import React, {Fragment} from 'react';
import _ from 'lodash';
import Pluralize from 'pluralize';
import BreachedServers from 'components/report-components/security/BreachedServers';
import ScannedServers from 'components/report-components/security/ScannedServers';
import StolenCredentialsTable from 'components/report-components/security/StolenCredentialsTable';
import {Line} from 'rc-progress';
import AuthComponent from '../AuthComponent';
import ReportHeader, {ReportTypes} from './common/ReportHeader';
import ReportLoader from './common/ReportLoader';
import SecurityIssuesGlance from './common/SecurityIssuesGlance';
import PrintReportButton from './common/PrintReportButton';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';

import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import guardicoreLogoImage from '../../images/guardicore-logo.png'
import {faExclamationTriangle} from '@fortawesome/free-solid-svg-icons';
import '../../styles/App.css';
import {
  crossSegmentIssueReport
} from './security/issues/CrossSegmentIssue';
import {getAllTunnels, tunnelIssueReportByMachine} from './security/issues/TunnelIssue';
import {
  zerologonOverviewWithFailedPassResetWarning
} from './security/issues/ZerologonIssue';
import AvailableCredentials from './security/AvailableCredentials';
import {
  getAllAgents,
  getAllMachines,
  getMachineByAgent,
  getMachineByID,
  getMachineHostname,
  getMachineIPs,
  getManuallyStartedAgents
} from '../utils/ServerUtils';
import CollapsibleWellComponent from './security/CollapsibleWell';


class ReportPageComponent extends AuthComponent {

  constructor(props) {
    super(props);
    this.state = {
      report: props.report,
      stolenCredentials: [],
      configuredCredentials: [],
      agents: [],
      machines: []
    };

    this.allTunnels = [];
  }

  componentDidMount() {
    this.getCredentialsFromServer();
    getAllAgents().then(agents => this.setState({agents: agents}));
    getAllMachines().then(machines => this.setState({machines: machines}));
  }

  getCredentialsFromServer = () => {
    this.authFetch('/api/propagation-credentials/stolen-credentials')
      .then(res => res.json())
      .then(creds => {
        this.setState({ stolenCredentials: creds });
      })
    this.authFetch('/api/propagation-credentials/configured-credentials')
      .then(res => res.json())
      .then(creds => {
        this.setState({ configuredCredentials: creds });
      })
  }

  componentWillUnmount() {
    clearInterval(this.interval);
  }

  componentDidUpdate(prevProps) {
    if (this.props.report !== prevProps.report) {
      this.setState({ report: this.props.report });
    }
  }

  render() {
    this.allTunnels = getAllTunnels(this.state.agents, this.state.machines);

    let content;

    if (this.stillLoadingDataFromServer()) {
      content = <ReportLoader loading={true} />;
    } else {
      content =
        <div>
          {this.generateReportOverviewSection()}
          {this.generateSegmentationSection()}
          {this.generateReportRecommendationsSection()}
          {this.generateReportGlanceSection()}
          {this.generateReportFooter()}
        </div>;
    }

    return (
      <Fragment>
        <div style={{ marginBottom: '20px' }}>
          <PrintReportButton onClick={() => {
            print();
          }} />
        </div>
        <div className='report-page'>
          <ReportHeader report_type={ReportTypes.security} />
          <hr />
          {content}
        </div>
        <div style={{ marginTop: '20px' }}>
          <PrintReportButton onClick={() => {
            print();
          }} />
        </div>
      </Fragment>
    );
  }

  stillLoadingDataFromServer() {
    return Object.keys(this.state.report).length === 0;
  }

  getMonkeyDuration() {
    if (this.state.report.overview.monkey_duration) {
      return <>
        After <span
        className='badge badge-info'>{this.state.report.overview.monkey_duration}</span>, all monkeys finished
        propagation attempts.
      </>
    } else {
      return <></>
    }
  }

  generateReportOverviewSection() {
    let manualMonkeyHostnames = getManuallyStartedAgents(this.state.agents).map((agent) => getMachineHostname(getMachineByAgent(agent, this.state.machines)));

    return (
      <div id='overview'>
        <h2>
          Overview
        </h2>
        <SecurityIssuesGlance issuesFound={this.state.report.glance.exploited_cnt > 0} />
        {
          this.state.report.glance.exploited_cnt > 0 ?
            ''
            :
            <p className='alert alert-info'>
              <FontAwesomeIcon icon={faExclamationTriangle} style={{ 'marginRight': '5px' }} />
              To improve Infection Monkey's detection rates, try adding credentials under <b>Propagation - Credentials
              </b> and updating network settings under <b>Propagation - Network analysis</b>.
            </p>
        }
        <p>
          The first monkey run was started on <span
            className='badge badge-info'>{this.state.report.overview.monkey_start_time}</span>. {this.getMonkeyDuration()}
        </p>
        <p>
          The monkey started propagating from the following machines where it was manually installed:
        </p>
        <ul>
          {[...new Set(manualMonkeyHostnames)].map(x => <li key={x}>{x}</li>)}
        </ul>
        <AvailableCredentials stolen={this.state.stolenCredentials} configured={this.state.configuredCredentials} />
        {
          this.state.report.overview.config_exploits.length > 0 ?
            (
              <p>
                The Monkey attempted the following exploitation methods:
                <ul>
                  {this.state.report.overview.config_exploits.map(x => <li key={x}>{x}</li>)}
                </ul>
              </p>
            )
            :
            <p>
              No exploiters were enabled.
            </p>
        }
        {
          this.state.report.overview.config_ips.length > 0 ?
            <p>
              The Monkey scans the following IPs:
              <ul>
                {this.state.report.overview.config_ips.map(x => <li key={x}>{x}</li>)}
              </ul>
            </p>
            :
            ''
        }
        {
          this.state.report.overview.config_scan ?
            ''
            :
            <p>
              Note: Monkeys were configured to avoid scanning of the local network.
            </p>
        }
      </div>
    );
  }

  generateReportRecommendationsSection() {
    return (
      <div id='recommendations'>
        {/* Checks if there are any issues. If there are more then one: render the title. Otherwise,
         * don't render it (since the issues themselves will be empty. */}
        {Object.keys(this.state.report.recommendations.issues).length !== 0 ?
          <h2>Machine-related Recommendations</h2> : null}
        <div>
          {this.generateIssues(this.state.report.recommendations.issues)}
        </div>
      </div>
    );
  }

  generateSegmentationSection() {
    if(this.state.report.cross_segment_issues.length === 0){
      return '';
    } else {
      return (
        <div>
          <h2>
            Segmentation Issues
          </h2>
          <div>
            The Monkey uncovered the following set of segmentation issues:
            <ul>
              {this.state.report.cross_segment_issues.map(x => crossSegmentIssueReport(x))}
            </ul>
          </div>
        </div>
      )
    }
  }

  generateReportGlanceSection() {
    let exploitPercentage =
      (100 * this.state.report.glance.exploited_cnt) / this.state.report.glance.scanned.length;
    return (
      <div id='glance'>
        <h2>
          The Network from the Monkey's Eyes
        </h2>
        <div>
          <p>
            The Monkey discovered <span
              className='badge badge-warning'>{this.state.report.glance.scanned.length}</span> machines and
            successfully breached <span
              className='badge badge-danger'>{this.state.report.glance.exploited_cnt}</span> of them.
          </p>
          <div className='text-center' style={{ margin: '10px' }}>
            <Line style={{ width: '300px', marginRight: '5px' }} percent={exploitPercentage} strokeWidth='4'
              trailWidth='4'
              strokeColor='#d9534f' trailColor='#f0ad4e' />
            <b>{Math.round(exploitPercentage)}% of scanned machines exploited</b>
          </div>
        </div>

        <div style={{ marginBottom: '20px' }}>
          <ScannedServers data={this.state.report.glance.scanned} />
        </div>

        <div style={{ marginBottom: '20px' }}>
          <p>
            The Monkey successfully breached&nbsp;
            <span className="badge badge-danger">
              {this.state.report.glance.exploited_cnt}
            </span> {Pluralize('machine', this.state.report.glance.exploited_cnt)}:
          </p>
          <BreachedServers />
        </div>

        <div style={{ marginBottom: '20px' }}>
          <StolenCredentialsTable stolenCredentials={this.state.stolenCredentials} />
        </div>
      </div>
    );
  }

  generateReportFooter() {
    return (
      <div id='footer' className='text-center' style={{ marginTop: '20px' }}>
        For questions, suggestions, or any other feedback,
        contact <a href='mailto://labs@guardicore.com' className='no-print'>labs@guardicore.com</a>
        <div className='force-print' style={{ display: 'none' }}>labs@guardicore.com</div>.
        <img src={guardicoreLogoImage} alt='GuardiCore' className='center-block' style={{ height: '50px' }} />
      </div>
    );
  }

  generateIssue = (issue) => {
    let remediation = <ReactMarkdown> 'No remediation available'</ReactMarkdown>;
    let description = '';

    if(_.has(issue, 'remediation_suggestion') && issue.remediation_suggestion !== undefined){
      remediation = <ReactMarkdown plugins={[remarkBreaks]}
                       linkTarget={'_blank'}
                       className={'markdown'}>
        {issue.remediation_suggestion}
      </ReactMarkdown>
    }
    if(_.has(issue, 'description') && issue.description !== undefined){
       description = <ReactMarkdown plugins={[remarkBreaks]}
                                   linkTarget={'_blank'}
                                   className={'markdown'}>
        {issue.description}
      </ReactMarkdown>
    }

    if(issue.type === 'ZerologonExploiter' && issue.password_restored === false){
      remediation = <>
        {zerologonOverviewWithFailedPassResetWarning()}
        <br/>
        <li>{remediation}</li>
      </>
    }

    let reportContentComponent = <div>
      {remediation}
      <CollapsibleWellComponent>
        {description}
      </CollapsibleWellComponent>
    </div>

    return <li key={JSON.stringify(issue)}>{reportContentComponent}</li>;
  };

  generateIssues = (issues) => {
    let issuesDivArray = [];

    for (let machineId of Object.keys(issues)) {
      let machine = getMachineByID(parseInt(machineId), this.state.machines);
      let hostname = getMachineHostname(machine);
      let machineIPs = getMachineIPs(machine);

      issuesDivArray.push(
        <li key={machineId}>
          <h4><b>{hostname} ({machineIPs.join(', ')})</b></h4>
          <ol>
            {issues[machineId].map(this.generateIssue)}
            {this.getTunnelIssue(parseInt(machineId))}
          </ol>
        </li>
      );
    }

    return <ul>{issuesDivArray}</ul>;
  };

  getTunnelIssue(machineId) {
    let tunnelIssue = tunnelIssueReportByMachine(machineId, this.allTunnels);
    if (tunnelIssue !== null) {
      return <li key={'tunneling-issue'}>{tunnelIssue}</li>
    } else {
      return null;
    }
  }
}

export default ReportPageComponent;
