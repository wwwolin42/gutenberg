/**
 * WordPress dependencies
 */
import { Component } from '@wordpress/element';
import isShallowEqual from '@wordpress/is-shallow-equal';
import { createHigherOrderComponent } from '@wordpress/compose';

/**
 * Internal dependencies
 */
import { RegistryConsumer } from '../registry-provider';
import { AsyncModeConsumer } from '../async-mode-provider';

const waitingList = [];
const componentsMap = new WeakMap();
let isRunning = false;
const runWaitingList = () => {
	if ( waitingList.length === 0 ) {
		isRunning = false;
		return;
	}
	const nextComponent = waitingList.shift();
	componentsMap.get( nextComponent )();
	componentsMap.delete( nextComponent );
	window.requestAnimationFrame( runWaitingList );
};

const addToWaitingList = ( component, item ) => {
	if ( ! componentsMap.has( component ) ) {
		waitingList.push( component );
	}
	componentsMap.set( component, item );
	if ( ! isRunning ) {
		isRunning = true;
		window.requestAnimationFrame( runWaitingList );
	}
};

const flushComponent = ( component ) => {
	if ( ! componentsMap.has( component ) ) {
		return false;
	}

	componentsMap.delete( component );
	const index = waitingList.indexOf( component );
	waitingList.splice( index, 1 );

	return true;
};

/**
 * Higher-order component used to inject state-derived props using registered
 * selectors.
 *
 * @param {Function} mapSelectToProps Function called on every state change,
 *                                   expected to return object of props to
 *                                   merge with the component's own props.
 *
 * @return {Component} Enhanced component with merged state data props.
 */
const withSelect = ( mapSelectToProps ) => createHigherOrderComponent( ( WrappedComponent ) => {
	/**
	 * Default merge props. A constant value is used as the fallback since it
	 * can be more efficiently shallow compared in case component is repeatedly
 	 * rendered without its own merge props.
	 *
	 * @type {Object}
	 */
	const DEFAULT_MERGE_PROPS = {};

	/**
	 * Given a props object, returns the next merge props by mapSelectToProps.
	 *
	 * @param {Object} props Props to pass as argument to mapSelectToProps.
	 *
	 * @return {Object} Props to merge into rendered wrapped element.
	 */
	function getNextMergeProps( props ) {
		return (
			mapSelectToProps( props.registry.select, props.ownProps, props.registry ) ||
			DEFAULT_MERGE_PROPS
		);
	}

	class ComponentWithSelect extends Component {
		constructor( props ) {
			super( props );

			this.onStoreChange = this.onStoreChange.bind( this );

			this.subscribe( props.registry );

			this.mergeProps = getNextMergeProps( props );
		}

		componentDidMount() {
			this.canRunSelection = true;

			// A state change may have occurred between the constructor and
			// mount of the component (e.g. during the wrapped component's own
			// constructor), in which case selection should be rerun.
			if ( this.hasQueuedSelection ) {
				this.hasQueuedSelection = false;
				this.onStoreChange();
			}
		}

		componentWillUnmount() {
			this.canRunSelection = false;
			this.unsubscribe();
			flushComponent( this );
		}

		shouldComponentUpdate( nextProps, nextState ) {
			// Cycle subscription if registry changes.
			const hasRegistryChanged = nextProps.registry !== this.props.registry;
			const hasSyncRenderingChanged = nextProps.isAsync !== this.props.isAsync;

			if ( hasRegistryChanged ) {
				this.unsubscribe();
				this.subscribe( nextProps.registry );
			}

			if ( hasSyncRenderingChanged ) {
				flushComponent( this );
			}

			// Treat a registry change as equivalent to `ownProps`, to reflect
			// `mergeProps` to rendered component if and only if updated.
			const hasPropsChanged = (
				hasRegistryChanged ||
				! isShallowEqual( this.props.ownProps, nextProps.ownProps )
			);

			// Only render if props have changed or merge props have been updated
			// from the store subscriber.
			if ( this.state === nextState && ! hasPropsChanged && ! hasSyncRenderingChanged ) {
				return false;
			}

			if ( hasPropsChanged || hasSyncRenderingChanged ) {
				const nextMergeProps = getNextMergeProps( nextProps );
				if ( ! isShallowEqual( this.mergeProps, nextMergeProps ) ) {
					// If merge props change as a result of the incoming props,
					// they should be reflected as such in the upcoming render.
					// While side effects are discouraged in lifecycle methods,
					// this component is used heavily, and prior efforts to use
					// `getDerivedStateFromProps` had demonstrated miserable
					// performance.
					this.mergeProps = nextMergeProps;
				}

				// Regardless whether merge props are changing, fall through to
				// incur the render since the component will need to receive
				// the changed `ownProps`.
			}

			return true;
		}

		onStoreChange() {
			if ( ! this.canRunSelection ) {
				this.hasQueuedSelection = true;
				return;
			}

			const nextMergeProps = getNextMergeProps( this.props );
			if ( isShallowEqual( this.mergeProps, nextMergeProps ) ) {
				return;
			}

			this.mergeProps = nextMergeProps;

			// Schedule an update. Merge props are not assigned to state since
			// derivation of merge props from incoming props occurs within
			// shouldComponentUpdate, where setState is not allowed. setState
			// is used here instead of forceUpdate because forceUpdate bypasses
			// shouldComponentUpdate altogether, which isn't desireable if both
			// state and props change within the same render. Unfortunately,
			// this requires that next merge props are generated twice.
			this.setState( {} );
		}

		subscribe( registry ) {
			this.unsubscribe = registry.subscribe( () => {
				if ( this.props.isAsync ) {
					addToWaitingList( this, this.onStoreChange );
				} else {
					this.onStoreChange();
				}
			} );
		}

		render() {
			return <WrappedComponent { ...this.props.ownProps } { ...this.mergeProps } />;
		}
	}

	return ( ownProps ) => (
		<AsyncModeConsumer>
			{ ( isAsync ) => (
				<RegistryConsumer>
					{ ( registry ) => (
						<ComponentWithSelect
							ownProps={ ownProps }
							registry={ registry }
							isAsync={ isAsync }
						/>
					) }
				</RegistryConsumer>
			) }
		</AsyncModeConsumer>
	);
}, 'withSelect' );

export default withSelect;
