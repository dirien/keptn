import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  ViewEncapsulation
} from '@angular/core';
import {Location} from '@angular/common';
import {ActivatedRoute, Params, Router} from '@angular/router';
import {DtQuickFilterDefaultDataSource, DtQuickFilterDefaultDataSourceConfig} from '@dynatrace/barista-components/quick-filter';
import {isObject} from '@dynatrace/barista-components/core';
import {combineLatest, Observable, Subject, Subscription, timer} from 'rxjs';
import {filter, map, startWith, switchMap, take, takeUntil} from 'rxjs/operators';
import * as moment from 'moment';
import {Stage} from '../../_models/stage';
import {Project} from '../../_models/project';
import {DataService} from '../../_services/data.service';
import {DateUtil} from '../../_utils/date.utils';
import {Sequence} from '../../_models/sequence';

@Component({
  selector: 'ktb-sequence-view',
  templateUrl: './ktb-sequence-view.component.html',
  styleUrls: ['./ktb-sequence-view.component.scss'],
  host: {
    class: 'ktb-sequence-view'
  },
  encapsulation: ViewEncapsulation.None,
  preserveWhitespaces: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KtbSequenceViewComponent implements OnInit, OnDestroy {

  private readonly unsubscribe$ = new Subject<void>();
  /** configuration for the quick filter **/
  private filterFieldData = {
    autocomplete: [
      {
        name: 'Service',
        showInSidebar: true,
        autocomplete: [],
      }, {
        name: 'Stage',
        showInSidebar: true,
        autocomplete: [],
      }, {
        name: 'Sequence',
        showInSidebar: true,
        autocomplete: [
        ],
      }, {
        name: 'Status',
        showInSidebar: true,
        autocomplete: [
          { name: 'Active', value: 'started' },
          { name: 'Failed', value: 'failed' },
          { name: 'Succeeded', value: 'succeeded' },
          { name: 'Waiting', value: 'waiting' }
        ],
      },
    ],
  };
  private _config: DtQuickFilterDefaultDataSourceConfig = {
    // Method to decide if a node should be displayed in the quick filter
    showInSidebar: (node) => isObject(node) && node.showInSidebar,
  };
  private sequenceFilters = {};
  private project: Project;

  private unfinishedSequences: Sequence[] = [];

  private _tracesTimerInterval = 10_000;
  private _sequenceTimerInterval = 30_000;
  private _tracesTimer: Subscription = Subscription.EMPTY;
  private _rootsTimer: Subscription = Subscription.EMPTY;

  public project$: Observable<Project>;
  public sequences$: Observable<Sequence[]>;
  public currentSequence: Sequence;
  public selectedStage: String;

  public _filterDataSource = new DtQuickFilterDefaultDataSource(
    this.filterFieldData,
    this._config,
  );
  public _seqFilters = [];

  constructor(private _changeDetectorRef: ChangeDetectorRef, private dataService: DataService, private route: ActivatedRoute, public dateUtil: DateUtil, private router: Router, private location: Location) { }

  ngOnInit() {
    const projectName$ = this.route.params
      .pipe(
        map(params => params.projectName)
      );

    this.sequences$ = this.dataService.sequences
      .pipe(
        takeUntil(this.unsubscribe$),
        filter(sequences => sequences?.length > 0)
      );

    this.project$ = projectName$.pipe(
      switchMap(projectName => this.dataService.getProject(projectName))
    );

    this.project$
      .pipe(
        takeUntil(this.unsubscribe$),
        filter(project => !!project && !!project.getServices() && !!project.stages)
      )
      .subscribe(project => {
        this.currentSequence = null;
        this.selectedStage = null;
        this.project = project;
        this.updateFilterDataSource(project);
        this._changeDetectorRef.markForCheck();
      });

    timer(0, this._sequenceTimerInterval)
      .pipe(
        startWith(0),
        switchMap(() => this.project$),
        filter(project => !!project && !!project.getServices()),
        takeUntil(this.unsubscribe$)
      ).subscribe(project => {
      this.dataService.loadSequences(project);
    });

    this._rootsTimer = timer(0, this._tracesTimerInterval * 1000)
      .pipe(takeUntil(this.unsubscribe$))
      .subscribe(() => {
        // This triggers the subscription for roots$
        this.unfinishedSequences.forEach(sequence => {
          this.dataService.loadTraces(sequence);
        });
    });

    // init; set parameters
    combineLatest([this.route.params, this.sequences$])
      .pipe(
        takeUntil(this.unsubscribe$),
        take(1)
      )
      .subscribe(([params, sequences]: [Params, Sequence[]]) => {
        const sequence = sequences.find(s => s.shkeptncontext === params.shkeptncontext);
        const stage = params.eventId ? sequence?.traces.find(t => t.id === params.eventId)?.getStage() : params.stage;
        const eventId = params.eventId;
        if (sequence) {
          this.selectSequence({ sequence, stage, eventId });
        } else if(params.shkeptncontext) {
          this.dataService.loadUntilRoot(this.project, params.shkeptncontext);
        }
    });

    this.sequences$.subscribe(sequences => {
      this.updateFilterSequence(sequences);
      this.refreshFilterDataSource();
      // Set unfinished roots so that the traces for updates can be loaded
      // Also ignore currently selected root, as this is getting already polled
      this.unfinishedSequences = sequences.filter(sequence => !sequence.isFinished() && sequence !== this.currentSequence);
    });
  }

  selectSequence(event: {sequence: Sequence, stage: string, eventId: string}): void {
    if (event.eventId) {
      const routeUrl = this.router.createUrlTree(['/project', event.sequence.project, 'sequence', event.sequence.shkeptncontext, 'event', event.eventId]);
      this.location.go(routeUrl.toString());
    } else {
      const stage = event.stage || event.sequence.getStages().pop();
      const routeUrl = this.router.createUrlTree(['/project', event.sequence.project, 'sequence', event.sequence.shkeptncontext, ...(stage ? ['stage', stage] : [])]);
      this.location.go(routeUrl.toString());
    }

    this.currentSequence = event.sequence;
    this.selectedStage = event.stage || event.sequence.getStages().pop();
    this.loadTraces(this.currentSequence);
  }

  loadTraces(sequence: Sequence): void {
    this._tracesTimer.unsubscribe();
    if(moment().subtract(1, 'day').isBefore(sequence.time)) {
      this._tracesTimer = timer(0, this._tracesTimerInterval)
        .pipe(takeUntil(this.unsubscribe$))
        .subscribe(() => {
          this.dataService.loadTraces(sequence);
        });
    } else {
      this.dataService.loadTraces(sequence);
      this._tracesTimer = Subscription.EMPTY;
    }
  }

  filtersChanged(event) {
    this._seqFilters = event.filters;
    this.sequenceFilters = this._seqFilters.reduce((filters, filter) => {
      if(!filters[filter[0].name])
        filters[filter[0].name] = [];
      filters[filter[0].name].push(filter[1].value);
      return filters;
    }, {});
  }

  updateFilterSequence(sequences: Sequence[]) {
    if (sequences) {
      this.filterFieldData.autocomplete.find(f => f.name == 'Sequence').autocomplete = sequences.map(s => s.name).filter((v, i, a) => a.indexOf(v) === i).map(seqName => Object.assign({}, {
        name: seqName,
        value: seqName
      }));
    }
  }

  updateFilterDataSource(project: Project) {
    this.filterFieldData.autocomplete.find(f => f.name == 'Service').autocomplete = project.services.map(s => Object.assign({}, { name: s.serviceName, value: s.serviceName }));
    this.filterFieldData.autocomplete.find(f => f.name == 'Stage').autocomplete = project.stages.map(s => Object.assign({}, { name: s.stageName, value: s.stageName }));
    this.updateFilterSequence(project.sequences);
    this.refreshFilterDataSource();

    this.filtersChanged({ filters: [] });
    this._changeDetectorRef.markForCheck();
  }

  private refreshFilterDataSource() {
    this._filterDataSource = new DtQuickFilterDefaultDataSource(
      this.filterFieldData,
      this._config,
    );
  }

  getFilteredSequences(sequences: Sequence[]) {
    if(sequences)
      return sequences.filter(s => {
        let res = true;
        Object.keys(this.sequenceFilters||{}).forEach((key) => {
          switch(key) {
            case "Service":
              res = res && this.sequenceFilters[key].includes(s.service);
              break;
            case "Stage":
              res = res && this.sequenceFilters[key].every(f => s.getStages().includes(f));
              break;
            case "Sequence":
              res = res && this.sequenceFilters[key].includes(s.name);
              break;
            case "Status":
              res = res && this.sequenceFilters[key].includes(s.getStatus());
              break;
          }
        });
        return res;
      });
  }

  getTracesLastUpdated(sequence: Sequence): Date {
    return this.dataService.getTracesLastUpdated(sequence);
  }

  showReloadButton(sequence: Sequence) {
    return moment().subtract(1, 'day').isAfter(sequence.time);
  }

  selectStage(stageName: string) {
    const routeUrl = this.router.createUrlTree(['/project', this.currentSequence.project, 'sequence', this.currentSequence.shkeptncontext, 'stage', stageName]);
    this.location.go(routeUrl.toString());

    this.selectedStage = stageName;
    this._changeDetectorRef.markForCheck();
  }

  ngOnDestroy(): void {
    this.unsubscribe$.next();
    this._tracesTimer.unsubscribe();
    this._rootsTimer.unsubscribe();
  }
}
