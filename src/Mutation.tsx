import * as React from 'react';
import * as PropTypes from 'prop-types';
import ApolloClient, { PureQueryOptions, ApolloError, FetchPolicy } from 'apollo-client';
import { DataProxy } from 'apollo-cache';
import { invariant } from 'ts-invariant';
import { DocumentNode, GraphQLError } from 'graphql';

import { OperationVariables, RefetchQueriesProviderFn } from './types';
import { parser, DocumentType } from './parser';
import { getClient } from './component-utils';
import { getApolloContext, ApolloContextValue } from './ApolloContext';

export interface MutationResult<TData = Record<string, any>> {
  data?: TData;
  error?: ApolloError;
  loading: boolean;
  called: boolean;
  client: ApolloClient<Object>;
}

export interface ExecutionResult<T = Record<string, any>> {
  data?: T;
  extensions?: Record<string, any>;
  errors?: GraphQLError[];
}

export declare type MutationUpdaterFn<
  T = {
    [key: string]: any;
  }
> = (proxy: DataProxy, mutationResult: FetchResult<T>) => void;

export declare type FetchResult<
  TData = Record<string, any>,
  C = Record<string, any>,
  E = Record<string, any>
> = ExecutionResult<TData> & {
  extensions?: E;
  context?: C;
};

export declare type MutationOptions<
  TData = Record<string, any>,
  TVariables = OperationVariables
> = {
  variables?: TVariables;
  optimisticResponse?: TData;
  refetchQueries?: Array<string | PureQueryOptions> | RefetchQueriesProviderFn;
  awaitRefetchQueries?: boolean;
  update?: MutationUpdaterFn<TData>;
  context?: Record<string, any>;
  fetchPolicy?: FetchPolicy;
};

export declare type MutationFn<TData = any, TVariables = OperationVariables> = (
  options?: MutationOptions<TData, TVariables>,
) => Promise<void | FetchResult<TData>>;

export interface MutationProps<TData = any, TVariables = OperationVariables> {
  client?: ApolloClient<Object>;
  mutation: DocumentNode;
  ignoreResults?: boolean;
  optimisticResponse?: TData;
  variables?: TVariables;
  refetchQueries?: Array<string | PureQueryOptions> | RefetchQueriesProviderFn;
  awaitRefetchQueries?: boolean;
  update?: MutationUpdaterFn<TData>;
  children: (
    mutateFn: MutationFn<TData, TVariables>,
    result: MutationResult<TData>,
  ) => React.ReactNode;
  onCompleted?: (data: TData) => void;
  onError?: (error: ApolloError) => void;
  context?: Record<string, any>;
  fetchPolicy?: FetchPolicy;
}

export interface MutationState<TData = any> {
  called: boolean;
  loading: boolean;
  error?: ApolloError;
  data?: TData;
}

class Mutation<TData = any, TVariables = OperationVariables> extends React.Component<
  MutationProps<TData, TVariables>,
  MutationState<TData>
> {
  static contextType = getApolloContext();

  static propTypes = {
    mutation: PropTypes.object.isRequired,
    variables: PropTypes.object,
    optimisticResponse: PropTypes.object,
    refetchQueries: PropTypes.oneOfType([
      PropTypes.arrayOf(PropTypes.oneOfType([PropTypes.string, PropTypes.object])),
      PropTypes.func,
    ]),
    awaitRefetchQueries: PropTypes.bool,
    update: PropTypes.func,
    children: PropTypes.func.isRequired,
    onCompleted: PropTypes.func,
    onError: PropTypes.func,
    fetchPolicy: PropTypes.string,
  };

  private mostRecentMutationId: number;
  private hasMounted: boolean = false;

  constructor(
    props: MutationProps<TData, TVariables>,
    context: ApolloContextValue,
  ) {
    super(props, context);
    this.verifyDocumentIsMutation(props.mutation);
    this.mostRecentMutationId = 0;
    this.state = {
      called: false,
      loading: false,
    };
  }

  componentDidMount() {
    this.hasMounted = true;
  }

  componentDidUpdate(prevProps: MutationProps<TData, TVariables>) {
    if (this.props.mutation !== prevProps.mutation) {
      this.verifyDocumentIsMutation(this.props.mutation);
    }
  }

  componentWillUnmount() {
    this.hasMounted = false;
  }

  render() {
    const { children } = this.props;
    const { loading, data, error, called } = this.state;

    const result = {
      called,
      loading,
      data,
      error,
      client: this.currentClient(),
    };

    return children(this.runMutation, result);
  }

  private runMutation = (options: MutationOptions<TData, TVariables> = {}) => {
    this.onMutationStart();
    const mutationId = this.generateNewMutationId();

    return this.mutate(options)
      .then((response: ExecutionResult<TData>) => {
        this.onMutationCompleted(response, mutationId);
        return response;
      })
      .catch((e: ApolloError) => {
        this.onMutationError(e, mutationId);
        if (!this.props.onError) throw e;
      });
  };

  private mutate = (options: MutationOptions<TData, TVariables>) => {
    const {
      mutation,
      variables,
      optimisticResponse,
      update,
      context = {},
      awaitRefetchQueries = false,
      fetchPolicy,
    } = this.props;
    const mutateOptions = { ...options };

    let refetchQueries = mutateOptions.refetchQueries || this.props.refetchQueries;
    const mutateVariables = Object.assign({}, variables, mutateOptions.variables);
    delete mutateOptions.variables;

    return this.currentClient().mutate({
      mutation,
      optimisticResponse,
      refetchQueries,
      awaitRefetchQueries,
      update,
      context,
      fetchPolicy,
      variables: mutateVariables,
      ...mutateOptions,
    });
  };

  private onMutationStart = () => {
    if (!this.state.loading && !this.props.ignoreResults) {
      this.setState({
        loading: true,
        error: undefined,
        data: undefined,
        called: true,
      });
    }
  };

  private onMutationCompleted = (response: ExecutionResult<TData>, mutationId: number) => {
    const { onCompleted, ignoreResults } = this.props;

    const { data, errors } = response;
    const error =
      errors && errors.length > 0 ? new ApolloError({ graphQLErrors: errors }) : undefined;

    const callOncomplete = () => (onCompleted ? onCompleted(data as TData) : null);

    if (this.hasMounted && this.isMostRecentMutation(mutationId) && !ignoreResults) {
      this.setState({ loading: false, data, error }, callOncomplete);
    } else {
      callOncomplete();
    }
  };

  private onMutationError = (error: ApolloError, mutationId: number) => {
    const { onError } = this.props;
    const callOnError = () => (onError ? onError(error) : null);

    if (this.hasMounted && this.isMostRecentMutation(mutationId)) {
      this.setState({ loading: false, error }, callOnError);
    } else {
      callOnError();
    }
  };

  private generateNewMutationId = (): number => {
    this.mostRecentMutationId = this.mostRecentMutationId + 1;
    return this.mostRecentMutationId;
  };

  private isMostRecentMutation = (mutationId: number) => {
    return this.mostRecentMutationId === mutationId;
  };

  private verifyDocumentIsMutation = (mutation: DocumentNode) => {
    const operation = parser(mutation);
    invariant(
      operation.type === DocumentType.Mutation,
      `The <Mutation /> component requires a graphql mutation, but got a ${
        operation.type === DocumentType.Query ? 'query' : 'subscription'
      }.`,
    );
  };

  private currentClient() {
    return getClient(this.props, this.context);
  }
}

export default Mutation;
